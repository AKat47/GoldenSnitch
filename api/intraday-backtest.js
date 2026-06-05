// api/intraday-backtest.js — Historical intraday strategy backtest
//
// Strategy: same rules as live scanner (VWAP, EMA9/21, ADX, RSI, Volume)
// Data: 60 days of 5-min OHLC + 90 days daily OHLC (Yahoo Finance)
//
// POST { symbols: [], minAdx: 25, minRsi: 55, maxRsi: 70, volMult: 2 }
// Returns { trades: [...], stats: {...} }

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Indicators ────────────────────────────────────────────
function ema(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      if (i < period - 1) continue;
      let sum = 0, cnt = 0;
      for (let j = i - period + 1; j <= i; j++) { if (arr[j] != null) { sum += arr[j]; cnt++; } }
      prev = sum / cnt; out[i] = prev;
    } else { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

function rsi(arr, period = 14) {
  const out = new Array(arr.length).fill(null);
  if (arr.length <= period) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = arr[i]-arr[i-1]; if(d>0)ag+=d; else al-=d; }
  ag /= period; al /= period;
  out[period] = 100 - 100 / (1 + ag / (al||0.0001));
  for (let i = period+1; i < arr.length; i++) {
    const d = arr[i]-arr[i-1], g=d>0?d:0, l=d<0?-d:0;
    ag=(ag*(period-1)+g)/period; al=(al*(period-1)+l)/period;
    out[i] = 100 - 100 / (1 + ag / (al||0.0001));
  }
  return out;
}

function vwapArr(highs, lows, closes, volumes) {
  let cumTV=0, cumVol=0;
  return closes.map((c,i)=>{
    const tp=(highs[i]+lows[i]+closes[i])/3;
    cumTV+=tp*(volumes[i]||0); cumVol+=(volumes[i]||0);
    return cumVol>0 ? cumTV/cumVol : c;
  });
}

function atr(highs, lows, closes, period=14) {
  const tr=closes.map((c,i)=>i===0?highs[i]-lows[i]:Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  let val=null; const out=new Array(tr.length).fill(null);
  for(let i=0;i<tr.length;i++){
    if(i<period-1)continue;
    if(i===period-1)val=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
    else val=(val*(period-1)+tr[i])/period;
    out[i]=val;
  }
  return out;
}

function adxCalc(highs, lows, closes, period=14) {
  const n=closes.length;
  const pDM=new Array(n).fill(0), mDM=new Array(n).fill(0), tr=new Array(n).fill(0);
  for(let i=1;i<n;i++){
    const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i];
    pDM[i]=(up>dn&&up>0)?up:0; mDM[i]=(dn>up&&dn>0)?dn:0;
    tr[i]=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
  }
  function ws(arr,p){
    const out=new Array(arr.length).fill(null);
    let s=0; for(let i=1;i<=p;i++)s+=arr[i]; out[p]=s;
    for(let i=p+1;i<arr.length;i++)out[i]=out[i-1]-out[i-1]/p+arr[i];
    return out;
  }
  const sTR=ws(tr,period), sP=ws(pDM,period), sM=ws(mDM,period);
  const dx=new Array(n).fill(null);
  for(let i=period;i<n;i++){
    if(!sTR[i])continue;
    const dP=(sP[i]/sTR[i])*100, dM=(sM[i]/sTR[i])*100;
    dx[i]=Math.abs(dP-dM)/(dP+dM)*100;
  }
  const adxOut=new Array(n).fill(null); let av=null;
  for(let i=period*2;i<n;i++){
    if(dx[i]==null)continue;
    if(av==null){av=dx[i];adxOut[i]=av;continue;}
    av=(av*(period-1)+dx[i])/period; adxOut[i]=av;
  }
  return adxOut;
}

// ── IST helpers ───────────────────────────────────────────
function istMins(ts) {
  // ts = Unix seconds
  const d = new Date(ts * 1000);
  const ist = new Date(d.getTime() + 5.5*60*60*1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ts) {
  const d = new Date(ts * 1000);
  const ist = new Date(d.getTime() + 5.5*60*60*1000);
  return ist.toISOString().split('T')[0];
}
function istTimeStr(ts) {
  const d = new Date(ts * 1000);
  const ist = new Date(d.getTime() + 5.5*60*60*1000);
  return String(ist.getUTCHours()).padStart(2,'0') + ':' + String(ist.getUTCMinutes()).padStart(2,'0');
}

// ── Wilder ATR for daily data ─────────────────────────────
function calcDailyATR(rows, period=14) {
  if (rows.length < period) return null;
  const tr=rows.map((r,i)=>i===0?r.high-r.low:Math.max(r.high-r.low,Math.abs(r.high-rows[i-1].close),Math.abs(r.low-rows[i-1].close)));
  let val=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++) val=(val*(period-1)+tr[i])/period;
  return val;
}

// ── Fetch daily OHLC ──────────────────────────────────────
async function fetchDaily(sym) {
  const ticker = sym+'.NS';
  const to=Math.floor(Date.now()/1000), from=to-100*86400;
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${to}&interval=1d`;
  const json=await httpsGet(url);
  const result=json?.chart?.result?.[0];
  if(!result)return null;
  const ts=result.timestamp||[], q=result.indicators?.quote?.[0]||{};
  const rows=ts.map((_,i)=>({
    date: istDateStr(ts[i]),
    close:q.close?.[i], high:q.high?.[i], low:q.low?.[i], volume:q.volume?.[i]??0
  })).filter(r=>r.close!=null&&r.high!=null&&r.low!=null);
  return rows;
}

// ── Fetch 5-min OHLC ──────────────────────────────────────
async function fetch5Min(sym) {
  const ticker = sym+'.NS';
  const to=Math.floor(Date.now()/1000), from=to-60*86400;
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${to}&interval=5m`;
  const json=await httpsGet(url);
  const result=json?.chart?.result?.[0];
  if(!result)return null;
  const ts=result.timestamp||[], q=result.indicators?.quote?.[0]||{};
  const name=result.meta?.longName||result.meta?.shortName||sym;
  const rows=ts.map((t,i)=>({
    ts:t, date:istDateStr(t), time:istTimeStr(t), minsIST:istMins(t),
    open:q.open?.[i], high:q.high?.[i], low:q.low?.[i], close:q.close?.[i], volume:q.volume?.[i]??0
  })).filter(r=>r.close!=null&&r.high!=null&&r.low!=null);
  return {rows, name};
}

// ── Simulate one trading day ──────────────────────────────
function simulateDay(candles, prevClose, avgDailyVol, cfg) {
  if(!candles.length) return null;

  const opens=candles.map(r=>r.open), highs=candles.map(r=>r.high);
  const lows=candles.map(r=>r.low), closes=candles.map(r=>r.close);
  const volumes=candles.map(r=>r.volume);
  const n=candles.length;

  // Gap filter (based on first candle open vs prevClose)
  const gapPct=prevClose ? (opens[0]-prevClose)/prevClose*100 : 0;
  if(prevClose&&(gapPct<-2||gapPct>3)) return {skipped:'gap', gapPct:+gapPct.toFixed(2)};

  // Opening volume filter
  const avgFiveMinVol = avgDailyVol ? avgDailyVol/75 : null;
  if(avgFiveMinVol&&volumes[0]<3*avgFiveMinVol) return {skipped:'opening_vol'};

  // Build indicators on all candles of this day
  const vwap  = vwapArr(highs, lows, closes, volumes);
  const ema9  = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiA  = rsi(closes, 14);
  const adxA  = adxCalc(highs, lows, closes, 14);
  const atr5  = atr(highs, lows, closes, 14);

  let trade = null;

  for(let i=1; i<n; i++) {
    const m = candles[i].minsIST;
    if(m < 9*60+30) continue;  // scan from 9:30
    if(m > 14*60+45) break;     // no new entries after 14:45

    // Already in a trade — check exits
    if(trade&&!trade.exitTime) {
      const exitMins = candles[i].minsIST;
      let exitReason = null, exitPrice = null;

      if(highs[i] >= trade.target)     { exitPrice=trade.target;    exitReason='target'; }
      else if(lows[i] <= trade.sl)     { exitPrice=trade.sl;        exitReason='sl'; }
      else if(closes[i]<(vwap[i]||0)) { exitPrice=closes[i];       exitReason='vwap_breach'; }
      else if(ema9[i]&&ema21[i]&&ema9[i]<ema21[i]) { exitPrice=closes[i]; exitReason='ema_cross'; }
      else if(exitMins>=15*60+10)      { exitPrice=closes[i];       exitReason='time_exit'; }

      if(exitReason) {
        trade.exitTime  = candles[i].time;
        trade.exitPrice = +exitPrice.toFixed(2);
        trade.exitReason= exitReason;
        trade.pnlPct    = +((exitPrice-trade.entryPrice)/trade.entryPrice*100).toFixed(2);
        trade.pnlRs     = +(exitPrice-trade.entryPrice).toFixed(2);
        trade.candlesHeld = i - trade.entryIdx;
        break;
      }
      continue;
    }

    if(trade) continue; // already exited

    // Check all BUY conditions
    const curClose=closes[i], curVWAP=vwap[i], curEMA9=ema9[i];
    const curEMA21=ema21[i], curRSI=rsiA[i], curADX=adxA[i], curATR=atr5[i];
    const vol20=volumes.slice(Math.max(0,i-20),i);
    const avgVol=vol20.length?vol20.reduce((a,b)=>a+b,0)/vol20.length:0;

    // Reject conditions
    if(curADX!=null&&curADX<20) continue;
    if(curRSI!=null&&curRSI>75)  continue;
    if(avgVol>0&&volumes[i]<=avgVol) continue;

    // Buy conditions
    const condVWAP  = curVWAP!=null && curClose>curVWAP;
    const condEMA   = curEMA9!=null && curEMA21!=null && curEMA9>curEMA21;
    const condADX   = curADX!=null  && curADX>cfg.minAdx;
    const condRSI   = curRSI!=null  && curRSI>=cfg.minRsi && curRSI<=cfg.maxRsi;
    const condVol   = avgVol>0 && volumes[i]>cfg.volMult*avgVol;

    if(condVWAP && condEMA && condADX && condRSI && condVol) {
      if(!curATR) continue;
      const entry = curClose;
      const risk  = 1.5 * curATR;
      trade = {
        entryTime:  candles[i].time,
        entryIdx:   i,
        entryPrice: +entry.toFixed(2),
        sl:         +(entry-risk).toFixed(2),
        target:     +(entry+2*risk).toFixed(2),
        vwapAtEntry:+curVWAP.toFixed(2),
        adxAtEntry: +curADX.toFixed(1),
        rsiAtEntry: +curRSI.toFixed(1),
        volRatioAtEntry: avgVol>0?+(volumes[i]/avgVol).toFixed(2):null,
        // will be filled on exit
        exitTime:null, exitPrice:null, exitReason:null, pnlPct:null, pnlRs:null, candlesHeld:null
      };
    }
  }

  // Force exit at last candle if still open
  if(trade&&!trade.exitTime&&n>0) {
    const ep=closes[n-1];
    trade.exitTime   = candles[n-1].time;
    trade.exitPrice  = +ep.toFixed(2);
    trade.exitReason = 'time_exit';
    trade.pnlPct     = +((ep-trade.entryPrice)/trade.entryPrice*100).toFixed(2);
    trade.pnlRs      = +(ep-trade.entryPrice).toFixed(2);
    trade.candlesHeld= n-1-(trade.entryIdx||0);
  }

  return trade || null;
}

// ── Process one symbol ────────────────────────────────────
async function backtestSymbol(sym, cfg) {
  const [dailyRows, fiveMinData] = await Promise.all([fetchDaily(sym), fetch5Min(sym)]);
  if(!dailyRows||!fiveMinData) return [];

  const {rows: fiveRows, name} = fiveMinData;

  // Build daily maps
  const dailyByDate = {};
  dailyRows.forEach(r => { dailyByDate[r.date] = r; });

  // Group 5-min rows by date
  const dayMap = {};
  fiveRows.forEach(r => {
    if(!dayMap[r.date]) dayMap[r.date] = [];
    dayMap[r.date].push(r);
  });

  // Get sorted trading days available in 5-min data
  const dates = Object.keys(dayMap).sort();
  const trades = [];

  for(const date of dates) {
    const candles = dayMap[date];

    // Find previous trading day for prevClose
    const prevDays = dailyRows.filter(r=>r.date<date).sort((a,b)=>a.date<b.date?1:-1);
    if(!prevDays.length) continue;
    const prevDay = prevDays[0];
    const prevClose = prevDay.close;

    // Daily universe filter — use last 20 daily rows up to (but not including) this date
    const dailyBefore = dailyRows.filter(r=>r.date<date).slice(-20);
    if(dailyBefore.length < 14) continue; // need enough for ATR

    const prevClose_ = prevDay.close;
    if(prevClose_ <= 100) continue; // close filter

    const avgTurnover = dailyBefore.reduce((s,r)=>s+r.close*r.volume,0)/dailyBefore.length;
    if(avgTurnover < 20e6) continue; // 20 crore turnover filter

    const atrVal = calcDailyATR(dailyBefore, 14);
    if(!atrVal) continue;
    const atrPct = atrVal/prevClose_*100;
    if(atrPct<1.5||atrPct>8) continue; // ATR% filter

    const avgDailyVol = dailyBefore.reduce((s,r)=>s+r.volume,0)/dailyBefore.length;
    const result = simulateDay(candles, prevClose, avgDailyVol, cfg);

    if(!result||result.skipped) continue;

    trades.push({
      sym, name, date,
      ...result,
    });
  }

  return trades;
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const body    = typeof req.body==='string' ? JSON.parse(req.body) : req.body;
  const symbols = (body?.symbols||[]).slice(0,100);
  const cfg = {
    minAdx:  parseFloat(body?.minAdx)  || 25,
    minRsi:  parseFloat(body?.minRsi)  || 55,
    maxRsi:  parseFloat(body?.maxRsi)  || 70,
    volMult: parseFloat(body?.volMult) || 2,
  };

  const allTrades = [];
  // Process 4 symbols in parallel (each needs 2 Yahoo calls)
  for(let i=0;i<symbols.length;i+=4){
    const batch=symbols.slice(i,i+4);
    const results=await Promise.all(batch.map(sym=>backtestSymbol(sym,cfg).catch(()=>[])));
    for(const t of results) allTrades.push(...t);
  }

  // Aggregate stats
  const wins   = allTrades.filter(t=>t.pnlPct>0);
  const losses = allTrades.filter(t=>t.pnlPct<=0);
  const byExit = {};
  allTrades.forEach(t=>{
    if(!byExit[t.exitReason]) byExit[t.exitReason]={count:0,wins:0,totalPnl:0};
    byExit[t.exitReason].count++;
    if(t.pnlPct>0)byExit[t.exitReason].wins++;
    byExit[t.exitReason].totalPnl+=t.pnlPct;
  });

  const avgPnl = allTrades.length ? allTrades.reduce((s,t)=>s+(t.pnlPct||0),0)/allTrades.length : 0;
  const avgWin = wins.length ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length : 0;
  const avgLoss= losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length : 0;

  // By symbol summary
  const bySym={};
  allTrades.forEach(t=>{
    if(!bySym[t.sym])bySym[t.sym]={sym:t.sym,name:t.name,trades:0,wins:0,totalPnl:0};
    bySym[t.sym].trades++;
    if(t.pnlPct>0)bySym[t.sym].wins++;
    bySym[t.sym].totalPnl+=t.pnlPct;
  });

  return res.status(200).json({
    ok: true,
    trades: allTrades,
    stats: {
      total:    allTrades.length,
      wins:     wins.length,
      losses:   losses.length,
      winRate:  allTrades.length ? +(wins.length/allTrades.length*100).toFixed(1) : 0,
      avgPnlPct:+avgPnl.toFixed(2),
      avgWinPct:+avgWin.toFixed(2),
      avgLossPct:+avgLoss.toFixed(2),
      byExit,
      bySym: Object.values(bySym).sort((a,b)=>b.totalPnl-a.totalPnl),
    },
    cfg,
  });
};
