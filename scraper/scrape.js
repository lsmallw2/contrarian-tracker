const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');

puppeteer.use(StealthPlugin());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://nba-tracker-641f0-default-rtdb.firebaseio.com'
});
const db = admin.database();

const teamMappings = {
    'ATL': ['atlanta', 'hawks'], 'BOS': ['boston', 'celtics'], 'BKN': ['brooklyn', 'nets'],
    'CHA': ['charlotte', 'hornets'], 'CHI': ['chicago', 'bulls'], 'CLE': ['cleveland', 'cavaliers'],
    'DAL': ['dallas', 'mavericks'], 'DEN': ['denver', 'nuggets'], 'DET': ['detroit', 'pistons'],
    'GSW': ['golden state', 'warriors'], 'HOU': ['houston', 'rockets'], 'IND': ['indiana', 'pacers'],
    'LAC': ['clippers'], 'LAL': ['lakers'], 'MEM': ['memphis', 'grizzlies'],
    'MIA': ['miami', 'heat'], 'MIL': ['milwaukee', 'bucks'], 'MIN': ['minnesota', 'timberwolves'],
    'NOP': ['new orleans', 'pelicans'], 'NYK': ['knicks'], 'OKC': ['oklahoma', 'thunder'],
    'ORL': ['orlando', 'magic'], 'PHI': ['philadelphia', 'sixers'], 'PHX': ['phoenix', 'suns'],
    'POR': ['portland', 'blazers'], 'SAC': ['sacramento', 'kings'], 'SAS': ['san antonio', 'spurs'],
    'TOR': ['toronto', 'raptors'], 'UTA': ['utah', 'jazz'], 'WAS': ['washington', 'wizards']
};

function findTeamCode(teamText) {
    if (!teamText) return null;
    const upperText = teamText.toUpperCase().trim();
    if (teamMappings[upperText]) return upperText;
    const normalized = teamText.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [code, variations] of Object.entries(teamMappings)) {
        for (const variation of variations) {
            if (normalized.includes(variation)) return code;
        }
    }
    return null;
}

function calcImpliedProb(ml) {
    if (ml < 0) return (Math.abs(ml) / (Math.abs(ml) + 100)) * 100;
    return (100 / (ml + 100)) * 100;
}

function parseSBDText(text) {
    const teams = {};
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const logoMatch = line.match(/logo([A-Z]{2,4})/i);
        if (logoMatch) {
            const teamCode = logoMatch[1].toUpperCase();
            const pcts = [];
            for (let j = i + 1; j < lines.length; j++) {
                const pctLine = lines[j].trim();
                const pctMatch = pctLine.match(/^(\d+)%$/);
                if (pctMatch) pcts.push(parseFloat(pctMatch[1]));
                if (lines[j].match(/logo([A-Z]{2,4})/i)) break;
            }
            if (pcts.length >= 4) {
                if (!teams[teamCode]) teams[teamCode] = {};
                teams[teamCode].mlMoney = pcts[1];
                teams[teamCode].spreadMoney = pcts[3];
            }
        }
    }
    return teams;
}

async function scrapeSBD(sportPath) {
    const url = `https://www.sportsbettingdime.com/${sportPath}/public-betting-trends/`;
    console.log(`Scraping ${url}`);
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 8000));
        const text = await page.evaluate(() => document.body.innerText);
        return parseSBDText(text);
    } finally {
        await browser.close();
    }
}

async function fetchBovadaOdds(sportKey) {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=spreads,h2h&bookmakers=bovada&oddsFormat=american`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Odds API: ${response.status}`);
    return response.json();
}

function findBovadaMatch(teamCode, bovadaOdds) {
    for (const game of bovadaOdds) {
        const homeCode = findTeamCode(game.home_team);
        const awayCode = findTeamCode(game.away_team);
        if (teamCode !== homeCode && teamCode !== awayCode) continue;
        const bovada = game.bookmakers?.find(b => b.key === 'bovada');
        if (!bovada) continue;
        const spreads = bovada.markets.find(m => m.key === 'spreads');
        const h2h = bovada.markets.find(m => m.key === 'h2h');
        if (!spreads || !h2h) continue;
        const spreadOutcome = spreads.outcomes.find(o => findTeamCode(o.name) === teamCode);
        const mlOutcome = h2h.outcomes.find(o => findTeamCode(o.name) === teamCode);
        const opponentCode = teamCode === homeCode ? awayCode : homeCode;
        return {
            spread: spreadOutcome?.point ?? 0,
            moneyline: mlOutcome?.price ?? 0,
            opponent: opponentCode
        };
    }
    return null;
}

async function processSport(name, sbdPath, oddsKey) {
    console.log(`\n=== ${name.toUpperCase()} ===`);
    try {
        const sbdData = await scrapeSBD(sbdPath);
        console.log(`SBD: ${Object.keys(sbdData).length} teams found`);
        const bovadaOdds = await fetchBovadaOdds(oddsKey);
        console.log(`Bovada: ${bovadaOdds.length} games`);
        const games = [];
        for (const teamCode in sbdData) {
            const sbd = sbdData[teamCode];
            if (sbd.spreadMoney === undefined || sbd.mlMoney === undefined) continue;
            const bovada = findBovadaMatch(teamCode, bovadaOdds);
            if (!bovada) {
                console.log(`No Bovada match for ${teamCode}`);
                continue;
            }
            const spreadGap = 50 - sbd.spreadMoney;
            const mlImplied = calcImpliedProb(bovada.moneyline);
            const mlGap = mlImplied - sbd.mlMoney;
            games.push({
                team: teamCode,
                opponent: bovada.opponent || '',
                spreadMoney: sbd.spreadMoney,
                mlMoney: sbd.mlMoney,
                bovadaSpread: bovada.spread,
                bovadaML: bovada.moneyline,
                spreadGap: Math.round(spreadGap * 10) / 10,
                mlGap: Math.round(mlGap * 10) / 10
            });
        }
        await db.ref(`global/data/${name}`).set({
            games,
            timestamp: Date.now()
        });
        console.log(`✓ Saved ${games.length} games for ${name}`);
    } catch (err) {
        console.error(`✗ ${name} error:`, err.message);
    }
}

async function main() {
    const sports = [
        { name: 'nba', sbdPath: 'nba', oddsKey: 'basketball_nba' },
        { name: 'mlb', sbdPath: 'mlb', oddsKey: 'baseball_mlb' },
        { name: 'nfl', sbdPath: 'nfl', oddsKey: 'americanfootball_nfl' },
        { name: 'nhl', sbdPath: 'nhl', oddsKey: 'icehockey_nhl' }
    ];
    for (const sport of sports) {
        await processSport(sport.name, sport.sbdPath, sport.oddsKey);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
