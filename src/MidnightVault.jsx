import { useState, useEffect, useRef, useCallback } from "react";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtUSD = (n, dec = 2) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

function getFGInfo(v) {
  if (v == null) return { label: "Loading…", color: "#64748b", bg: "rgba(100,116,139,0.1)" };
  if (v < 25)  return { label: "Extreme Fear",  color: "#ef4444", bg: "rgba(239,68,68,0.12)"  };
  if (v < 45)  return { label: "Fear",          color: "#f97316", bg: "rgba(249,115,22,0.12)" };
  if (v < 56)  return { label: "Neutral",       color: "#eab308", bg: "rgba(234,179,8,0.12)"  };
  if (v < 75)  return { label: "Greed",         color: "#22c55e", bg: "rgba(34,197,94,0.12)"  };
  return              { label: "Extreme Greed", color: "#06b6d4", bg: "rgba(6,182,212,0.12)"  };
}

function zoneOf(v) {
  if (v == null) return -1;
  return v < 25 ? 0 : v < 45 ? 1 : v < 56 ? 2 : v < 75 ? 3 : 4;
}

// Default built-in strategies per zone
const DEFAULT_ZONES = [
  { id:"extreme_fear",  lo:0,  hi:24,  name:"EXTREME FEAR",  color:"#ef4444", action:"BUY HEAVY",    btc:50, eth:30, sol:15, other:5  },
  { id:"fear",          lo:25, hi:44,  name:"FEAR",          color:"#f97316", action:"BUY MODERATE", btc:40, eth:30, sol:20, other:10 },
  { id:"neutral",       lo:45, hi:55,  name:"NEUTRAL",       color:"#eab308", action:"HOLD",         btc:25, eth:25, sol:25, other:25 },
  { id:"greed",         lo:56, hi:74,  name:"GREED",         color:"#22c55e", action:"TAKE PROFITS", btc:30, eth:25, sol:20, other:25 },
  { id:"extreme_greed", lo:75, hi:100, name:"EXTREME GREED", color:"#06b6d4", action:"REDUCE RISK",  btc:45, eth:20, sol:10, other:25 },
];

function getAllocForValue(v, strategies, activeStratId) {
  const strat = strategies.find(s => s.id === activeStratId);
  if (!strat) return { action:"…", desc:"No strategy selected.", btc:25, eth:25, sol:25, other:25 };
  const zone = strat.zones.find(z => v != null && v >= z.lo && v <= z.hi);
  if (!zone) return { action:"…", desc:"Loading…", btc:25, eth:25, sol:25, other:25 };
  return { action: zone.action, desc: zone.desc || "", btc: zone.btc, eth: zone.eth, sol: zone.sol, other: zone.other };
}

// ─── Symbol → CoinGecko ID mapping ───────────────────────────────────────────
const SYMBOL_TO_CG_ID = {
  BTC:"bitcoin", ETH:"ethereum", SOL:"solana", AVAX:"avalanche-2",
  DOT:"polkadot", ADA:"cardano", LINK:"chainlink", MATIC:"matic-network",
  ATOM:"cosmos", UNI:"uniswap", DOGE:"dogecoin", SHIB:"shiba-inu",
  XRP:"ripple", LTC:"litecoin", BNB:"binancecoin", TRX:"tron",
  NEAR:"near", ARB:"arbitrum", OP:"optimism", APT:"aptos",
  SUI:"sui", SEI:"sei-network", INJ:"injective-protocol", TIA:"celestia",
  FET:"fetch-ai", RNDR:"render-token", WIF:"dogwifcoin", PEPE:"pepe",
  FIL:"filecoin", AAVE:"aave", MKR:"maker", CRV:"curve-dao-token",
};

function getCoinGeckoId(symbol) {
  return SYMBOL_TO_CG_ID[symbol.toUpperCase()] || symbol.toLowerCase();
}

// ─── Live Fear & Greed Index from alternative.me ─────────────────────────────
async function fetchLiveFG() {
  const res = await fetch("https://api.alternative.me/fng/?limit=31&format=json");
  if (!res.ok) throw new Error(`FNG API ${res.status}`);
  const json = await res.json();
  const entries = json.data;
  if (!entries || !entries.length) throw new Error("No FNG data");
  const current = entries[0];
  const yesterday = entries[1] || null;
  const lastWeek  = entries[7] || null;
  const lastMonth = entries[30] || entries[entries.length - 1] || null;
  // entries[0] = today, entries[1..15] = last 15 days (newest first → reverse for sparkline)
  const history = entries.slice(1, 16).map(e => Number(e.value)).reverse();
  return {
    value: Number(current.value),
    label: current.value_classification,
    history,
    yesterday: yesterday ? { value: Number(yesterday.value), label: yesterday.value_classification } : null,
    lastWeek:  lastWeek  ? { value: Number(lastWeek.value),  label: lastWeek.value_classification  } : null,
    lastMonth: lastMonth ? { value: Number(lastMonth.value), label: lastMonth.value_classification } : null,
  };
}

// ─── Live Prices from CoinGecko ──────────────────────────────────────────────
async function fetchLivePrices(symbols) {
  const ids = symbols.map(getCoinGeckoId).join(",");
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error(`CoinGecko API ${res.status}`);
  const json = await res.json();
  // Map CoinGecko response back to symbol-keyed format the app expects
  const result = {};
  for (const sym of symbols) {
    const cgId = getCoinGeckoId(sym);
    const entry = json[cgId];
    if (entry) {
      result[sym] = {
        price: entry.usd ?? null,
        change24h: entry.usd_24h_change != null ? Math.round(entry.usd_24h_change * 100) / 100 : null,
      };
    }
  }
  return result;
}

// ─── UI Atoms ─────────────────────────────────────────────────────────────────
function Sparkline({ data, color, w = 110, h = 36 }) {
  if (!data || data.length < 2) return <div style={{ width: w, height: h }} />;
  const min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1)) * w},${h - ((v - min) / rng) * (h - 4) + 2}`
  ).join(" ");
  const uid = "sp" + w + h + color.replace(/[^a-z0-9]/gi, "");
  return (
    <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#${uid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FGGauge({ value }) {
  const info  = getFGInfo(value);
  const toRad = d => (d * Math.PI) / 180;
  // Center & radius
  const cx = 100, cy = 92, r = 76, nr = 60;
  // Arc from 135° (bottom-left) clockwise through top to 45° (bottom-right) = 270° sweep
  // In SVG: 0°=right, 90°=down, 180°=left, 270°=up
  const START = 135, SWEEP = 270;
  const arc = (s, e, rad) => {
    const S = { x: cx + rad * Math.cos(toRad(s)), y: cy + rad * Math.sin(toRad(s)) };
    const E = { x: cx + rad * Math.cos(toRad(e)), y: cy + rad * Math.sin(toRad(e)) };
    const diff = e - s;
    return `M ${S.x} ${S.y} A ${rad} ${rad} 0 ${diff > 180 ? 1 : 0} 1 ${E.x} ${E.y}`;
  };
  // Needle angle: 0→135° (bottom-left), 100→405°/45° (bottom-right)
  const angle = value == null ? START : START + (value / 100) * SWEEP;
  const nx = cx + nr * Math.cos(toRad(angle));
  const ny = cy + nr * Math.sin(toRad(angle));
  // 5 segments, each 54°
  const segs = [
    { s:135, e:189, c:"#ef4444" }, // Extreme Fear (lower-left → left)
    { s:189, e:243, c:"#f97316" }, // Fear (left → upper-left)
    { s:243, e:297, c:"#eab308" }, // Neutral (upper-left → upper-right)
    { s:297, e:351, c:"#22c55e" }, // Greed (upper-right → right)
    { s:351, e:405, c:"#06b6d4" }, // Extreme Greed (right → lower-right)
  ];
  // Tick marks at 0, 25, 50, 75, 100
  const ticks = [0, 25, 50, 75, 100].map(v => {
    const a = START + (v / 100) * SWEEP;
    return {
      v,
      x1: cx + (r + 6) * Math.cos(toRad(a)),
      y1: cy + (r + 6) * Math.sin(toRad(a)),
      x2: cx + (r + 12) * Math.cos(toRad(a)),
      y2: cy + (r + 12) * Math.sin(toRad(a)),
      tx: cx + (r + 22) * Math.cos(toRad(a)),
      ty: cy + (r + 22) * Math.sin(toRad(a)),
    };
  });
  return (
    <svg viewBox="0 0 200 160" style={{ width: "100%", maxWidth: 220 }}>
      <defs>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {/* Background segments */}
      {segs.map((s, i) => (
        <path key={i} d={arc(s.s, s.e, r)} fill="none"
          stroke={s.c} strokeWidth="14" strokeLinecap="round" opacity="0.15" />
      ))}
      {/* Active arc */}
      {value != null && (
        <path d={arc(START, angle, r)} fill="none"
          stroke={info.color} strokeWidth="14" strokeLinecap="round"
          filter="url(#glow)" />
      )}
      {/* Tick marks */}
      {ticks.map(t => (
        <g key={t.v}>
          <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinecap="round" />
          <text x={t.tx} y={t.ty} textAnchor="middle" dominantBaseline="middle"
            style={{ fill:"rgba(255,255,255,0.2)", fontSize:9, fontFamily:"monospace" }}>
            {t.v}
          </text>
        </g>
      ))}
      {/* Needle */}
      <line x1={cx} y1={cy} x2={nx} y2={ny}
        stroke={info.color} strokeWidth="2.5" strokeLinecap="round" />
      {/* Center dot */}
      <circle cx={cx} cy={cy} r="6" fill="#0c1220" stroke={info.color} strokeWidth="2"
        filter="url(#glow)" />
      <circle cx={cx} cy={cy} r="2.5" fill={info.color} />
      {/* Value text */}
      <text x={cx} y={cy + 28} textAnchor="middle"
        style={{ fill: info.color, fontSize: 25, fontFamily: "monospace", fontWeight: 800 }}>
        {value ?? "…"}
      </text>
      {/* Label */}
      <text x={cx} y={cy + 42} textAnchor="middle"
        style={{ fill: info.color, fontSize: 10, fontFamily: "monospace", letterSpacing: 2, opacity: 0.7 }}>
        {info.label.toUpperCase()}
      </text>
    </svg>
  );
}

function AllocBar({ btc, eth, sol, other }) {
  const items = [
    { l:"BTC",  p:btc,   c:"#F7931A" },
    { l:"ETH",  p:eth,   c:"#627EEA" },
    { l:"SOL",  p:sol,   c:"#9945FF" },
    { l:"OTHER",p:other, c:"#06b6d4" },
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
      <div style={{ display:"flex", height:9, borderRadius:6, overflow:"hidden", gap:2 }}>
        {items.map(it => (
          <div key={it.l} style={{ width:`${it.p}%`, background:it.c, transition:"width 0.8s ease" }} />
        ))}
      </div>
      <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
        {items.map(it => (
          <div key={it.l} style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:7, height:7, borderRadius:2, background:it.c }} />
            <span style={{ color:"#94a3b8", fontSize:11, fontFamily:"monospace" }}>
              {it.l} {it.p}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ color = "#22c55e", text }) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5, padding:"3px 9px",
      borderRadius:20, background:`${color}18`, border:`1px solid ${color}40`,
      fontSize:10, fontFamily:"monospace", color,
    }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:color,
        display:"inline-block", animation:"blink 2s infinite" }} />
      {text}
    </span>
  );
}

// ─── Allocation Slider ────────────────────────────────────────────────────────
function AllocSlider({ label, color, value, onChange, disabled }) {
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <div style={{ width:9, height:9, borderRadius:2, background:color }} />
          <span style={{ fontSize:12, fontFamily:"monospace", color:"#e2e8f0" }}>{label}</span>
        </div>
        <span style={{ fontSize:13, fontWeight:700, fontFamily:"monospace", color }}>{value}%</span>
      </div>
      <div style={{ position:"relative", height:6, borderRadius:4,
        background:"rgba(255,255,255,0.07)", cursor: disabled ? "not-allowed" : "pointer" }}>
        <div style={{ position:"absolute", left:0, top:0, height:"100%",
          width:`${value}%`, background:color, borderRadius:4,
          boxShadow:`0 0 8px ${color}60`, transition:"width 0.1s" }} />
        <input type="range" min="0" max="100" value={value}
          onChange={e => onChange(Number(e.target.value))}
          disabled={disabled}
          style={{ position:"absolute", inset:0, width:"100%", height:"100%",
            opacity:0, cursor: disabled ? "not-allowed" : "pointer", margin:0 }} />
      </div>
    </div>
  );
}

// ─── BASE ASSETS ─────────────────────────────────────────────────────────────
const BASE_ASSETS = [
  { id:"BTC", symbol:"BTC", name:"Bitcoin",  color:"#F7931A", balance:0 },
  { id:"ETH", symbol:"ETH", name:"Ethereum", color:"#627EEA", balance:0 },
  { id:"SOL", symbol:"SOL", name:"Solana",   color:"#9945FF", balance:0 },
];

const DEFAULT_BUILT_IN_STRATEGY = {
  id: "builtin_default",
  name: "F&G Default",
  desc: "Classic Fear & Greed rebalancing strategy",
  isBuiltin: true,
  zones: DEFAULT_ZONES.map(z => ({
    ...z,
    action: z.action,
    desc: "",
  })),
};

// ─── MAIN ────────────────────────────────────────────────────────────────────
export default function MidnightVault() {
  const [tab, setTab]           = useState("vault");
  const [assets, setAssets]     = useState(BASE_ASSETS);
  const [custom, setCustom]     = useState([]);
  const [autoInvest, setAI]     = useState(true);
  const [connected, setConn]    = useState(false);
  const [connecting, setCing]   = useState(false);
  const [txLog, setTxLog]       = useState([]);
  const [depModal, setDepMod]   = useState(null);
  const [depAmt, setDepAmt]     = useState("");
  const [addModal, setAddMod]   = useState(false);
  const [newCoin, setNewCoin]   = useState({ symbol:"", name:"", color:"#06b6d4" });
  const [rebal, setRebal]       = useState(false);
  const [toast, setToast]       = useState(null);

  // strategy state
  const [strategies, setStrategies]   = useState([DEFAULT_BUILT_IN_STRATEGY]);
  const [activeStratId, setActiveSId] = useState("builtin_default");
  const [stratEditor, setStratEditor] = useState(null); // null or strategy object being edited
  const [editingZoneIdx, setEditZone] = useState(0);

  // live data
  const [fg, setFg]           = useState({ value:null, label:null, history:[], yesterday:null, lastWeek:null, lastMonth:null, ts:null, status:"idle" });
  const [prices, setPrices]   = useState({});
  const [pxTs, setPxTs]       = useState(null);
  const [pxStatus, setPxStatus] = useState("idle");
  const [countdown, setCountdown] = useState({ price:10, fg:30 });
  const [liveClock, setLiveClock] = useState(new Date().toLocaleTimeString());

  const prevZone = useRef(null);
  const allSyms  = [...assets.map(a => a.symbol), ...custom.map(c => c.symbol)];
  const pxTimer  = useRef(10);
  const fgTimer  = useRef(30);
  const isVisible = useRef(true);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const loadFG = useCallback(async () => {
    setFg(p => ({ ...p, status:"loading" }));
    try {
      const data = await fetchLiveFG();
      setFg({
        value:Number(data.value), label:data.label || getFGInfo(Number(data.value)).label,
        history:Array.isArray(data.history)?data.history.map(Number):[],
        yesterday: data.yesterday, lastWeek: data.lastWeek, lastMonth: data.lastMonth,
        ts:new Date().toLocaleTimeString(), status:"ok"
      });
      fgTimer.current = 30;
    } catch {
      setFg(p => ({ ...p, status:"error" }));
      fgTimer.current = 10; // retry faster on error
    }
  }, []);

  const loadPrices = useCallback(async (syms) => {
    if (!syms.length) return;
    setPxStatus("loading");
    try {
      const data = await fetchLivePrices(syms);
      setPrices(data); setPxTs(new Date().toLocaleTimeString()); setPxStatus("ok");
      pxTimer.current = 10;
    } catch {
      setPxStatus("error");
      pxTimer.current = 5; // retry faster on error
    }
  }, []);

  // Initial load
  useEffect(() => { loadFG(); loadPrices(allSyms); }, []);

  // Visibility API — pause when tab hidden, resume when visible
  useEffect(() => {
    const onVis = () => {
      isVisible.current = !document.hidden;
      if (!document.hidden) {
        // immediately refresh when user comes back
        loadFG(); loadPrices(allSyms);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [allSyms.join(",")]);

  // Master tick — runs every second, drives countdowns + auto-fetch
  useEffect(() => {
    const tick = setInterval(() => {
      setLiveClock(new Date().toLocaleTimeString());
      if (!isVisible.current) return;
      pxTimer.current -= 1;
      fgTimer.current -= 1;
      setCountdown({ price: Math.max(0, pxTimer.current), fg: Math.max(0, fgTimer.current) });
      if (pxTimer.current <= 0) { pxTimer.current = 10; loadPrices(allSyms); }
      if (fgTimer.current <= 0) { fgTimer.current = 30; loadFG(); }
    }, 1000);
    return () => clearInterval(tick);
  }, [allSyms.join(","), loadFG, loadPrices]);

  // auto-rebalance
  useEffect(() => {
    if (!autoInvest || !connected || fg.value == null) return;
    const z = zoneOf(fg.value);
    if (prevZone.current !== null && prevZone.current !== z) triggerRebal();
    prevZone.current = z;
  }, [fg.value, autoInvest, connected]);

  const triggerRebal = () => {
    setRebal(true);
    setTimeout(() => {
      setRebal(false);
      const alloc = getAllocForValue(fg.value, strategies, activeStratId);
      const h = "0x" + Array.from({length:8}, () => (Math.random()*16|0).toString(16)).join("");
      addTx("rebalance", `Auto-rebalance → ${alloc.action}`, h);
      notify(`⚡ Rebalanced: ${alloc.action}`);
    }, 2000);
  };

  const notify = msg => { setToast(msg); setTimeout(() => setToast(null), 3500); };
  const addTx  = (type, desc, hash) => setTxLog(l => [{
    id:Date.now(), type, desc, hash, time:new Date().toLocaleTimeString(),
    block:Math.floor(Math.random()*999999+1000000),
  }, ...l].slice(0,30));

  const handleConnect = () => {
    setCing(true);
    setTimeout(() => {
      setConn(true); setCing(false);
      addTx("connect","Wallet connected to Midnight Testnet","0x"+Math.random().toString(16).slice(2,10));
      notify("🔗 Connected to Midnight Testnet");
    }, 1800);
  };

  const handleDeposit = () => {
    const amt = parseFloat(depAmt);
    if (!amt || amt <= 0) return;
    setAssets(prev => prev.map(a => a.id === depModal.id ? {...a, balance:+(a.balance+amt).toFixed(6)} : a));
    addTx("deposit",`Deposited ${amt} ${depModal.symbol}`,"0x"+Math.random().toString(16).slice(2,10));
    notify(`✅ Deposited ${amt} ${depModal.symbol}`);
    setDepMod(null); setDepAmt("");
  };

  const handleAddCoin = () => {
    if (!newCoin.symbol || !newCoin.name) return;
    const sym = newCoin.symbol.toUpperCase();
    setCustom(prev => [...prev, {id:sym,symbol:sym,name:newCoin.name,color:newCoin.color,balance:0}]);
    loadPrices([...allSyms, sym]);
    setAddMod(false); setNewCoin({symbol:"",name:"",color:"#06b6d4"});
    notify(`➕ Added ${sym}`);
  };

  // ── Strategy CRUD ─────────────────────────────────────────────────────────
  const newBlankStrategy = () => ({
    id: "custom_" + Date.now(),
    name: "My Strategy",
    desc: "",
    isBuiltin: false,
    zones: DEFAULT_ZONES.map(z => ({
      ...z,
      btc: 25, eth: 25, sol: 25, other: 25,
      action: z.action,
      desc: "",
    })),
  });

  const openNewStrategy = () => {
    setStratEditor(newBlankStrategy());
    setEditZone(0);
    setTab("strategy");
  };

  const openEditStrategy = (strat) => {
    setStratEditor(JSON.parse(JSON.stringify(strat)));
    setEditZone(0);
    setTab("strategy");
  };

  const saveStrategy = () => {
    if (!stratEditor) return;
    // validate all zones sum ≈ 100
    for (const z of stratEditor.zones) {
      const sum = z.btc + z.eth + z.sol + z.other;
      if (Math.abs(sum - 100) > 0.5) {
        notify(`⚠ Zone "${z.name}" allocations must sum to 100% (currently ${sum}%)`);
        return;
      }
    }
    setStrategies(prev => {
      const exists = prev.find(s => s.id === stratEditor.id);
      return exists ? prev.map(s => s.id === stratEditor.id ? stratEditor : s)
                    : [...prev, stratEditor];
    });
    setActiveSId(stratEditor.id);
    setStratEditor(null);
    notify(`✅ Strategy "${stratEditor.name}" saved & activated`);
    setTab("invest");
  };

  const deleteStrategy = (id) => {
    if (id === "builtin_default") return;
    setStrategies(prev => prev.filter(s => s.id !== id));
    if (activeStratId === id) setActiveSId("builtin_default");
    notify("🗑 Strategy deleted");
  };

  const updateZoneAlloc = (zIdx, field, val) => {
    setStratEditor(prev => {
      const zones = prev.zones.map((z, i) => i === zIdx ? {...z, [field]: val} : z);
      return {...prev, zones};
    });
  };

  // normalize so remaining 3 auto-adjust to keep sum = 100
  const normalizeAlloc = (zIdx, changed, val) => {
    setStratEditor(prev => {
      const zone = {...prev.zones[zIdx]};
      zone[changed] = val;
      const fields = ["btc","eth","sol","other"];
      const others  = fields.filter(f => f !== changed);
      const remaining = 100 - val;
      const currentOtherSum = others.reduce((s,f) => s + zone[f], 0);
      if (currentOtherSum === 0) {
        others.forEach(f => { zone[f] = Math.floor(remaining / others.length); });
      } else {
        others.forEach(f => {
          zone[f] = Math.max(0, Math.round((zone[f] / currentOtherSum) * remaining));
        });
      }
      // fix rounding
      const total = fields.reduce((s,f) => s + zone[f], 0);
      const diff  = 100 - total;
      if (diff !== 0) {
        const adj = others.find(f => zone[f] + diff >= 0);
        if (adj) zone[adj] += diff;
      }
      const zones = prev.zones.map((z,i) => i === zIdx ? zone : z);
      return {...prev, zones};
    });
  };

  // derived
  const allAssets = [...assets, ...custom].map(a => ({
    ...a,
    price:  prices[a.symbol]?.price    ?? null,
    change: prices[a.symbol]?.change24h ?? null,
  }));
  const totalUSD   = allAssets.reduce((s,a) => s + a.balance*(a.price??0), 0);
  const fgInfo     = getFGInfo(fg.value);
  const activeAlloc = getAllocForValue(fg.value, strategies, activeStratId);
  const activeStrat = strategies.find(s => s.id === activeStratId) || strategies[0];

  // ── Shared style helpers ──────────────────────────────────────────────────
  const card  = { background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:14, padding:20 };
  const cg    = c => ({ ...card, border:`1px solid ${c}35`, boxShadow:`0 0 18px ${c}0a` });
  const lbl   = { fontSize:10, letterSpacing:2, color:"#475569", fontFamily:"monospace", marginBottom:6 };
  const tabSt = a => ({ flex:1, padding:"9px 0", borderRadius:7, border:"none",
    background: a?"rgba(6,182,212,0.15)":"transparent", color:a?"#06b6d4":"#64748b",
    cursor:"pointer", fontSize:12, fontWeight:700, letterSpacing:1, transition:"all 0.2s" });
  const btn   = (c, full=false) => ({
    background:`${c}18`, border:`1px solid ${c}55`, borderRadius:8,
    color:c, cursor:"pointer", fontSize:12, fontFamily:"monospace",
    padding:"9px 18px", letterSpacing:1, transition:"all 0.2s",
    width: full?"100%":"auto",
  });
  const inp   = { width:"100%", background:"rgba(255,255,255,0.05)",
    border:"1px solid rgba(255,255,255,0.12)", borderRadius:8, padding:"10px 14px",
    color:"#e2e8f0", fontSize:14, fontFamily:"monospace", outline:"none",
    boxSizing:"border-box", marginBottom:10 };
  const ov    = { position:"fixed", inset:0, background:"rgba(0,0,0,0.8)",
    backdropFilter:"blur(6px)", zIndex:100, display:"flex",
    alignItems:"center", justifyContent:"center" };
  const mod   = { background:"#0c1220", border:"1px solid rgba(6,182,212,0.35)",
    borderRadius:16, padding:28, width:340, boxShadow:"0 0 40px rgba(6,182,212,0.15)" };

  const TABS = [
    ["vault","⬡ VAULT"],
    ["invest","⚡ STRATEGY"],
    ["strategy","✦ BUILD"],
    ["activity","◎ ACTIVITY"],
  ];

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&display=swap" rel="stylesheet"/>

      <div style={{ minHeight:"100vh", background:"#050810", color:"#e2e8f0",
        fontFamily:"'Syne',sans-serif", position:"relative", overflow:"hidden" }}>

        {/* BG */}
        <div style={{ position:"fixed", inset:0, zIndex:0, pointerEvents:"none",
          backgroundImage:`linear-gradient(rgba(6,182,212,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(6,182,212,0.04) 1px,transparent 1px)`,
          backgroundSize:"48px 48px" }} />
        <div style={{ position:"fixed", top:-200, left:-200, width:600, height:600,
          borderRadius:"50%", zIndex:0, pointerEvents:"none",
          background:"radial-gradient(circle,rgba(6,182,212,0.08) 0%,transparent 70%)" }} />
        <div style={{ position:"fixed", bottom:-150, right:-150, width:500, height:500,
          borderRadius:"50%", zIndex:0, pointerEvents:"none",
          background:"radial-gradient(circle,rgba(153,69,255,0.08) 0%,transparent 70%)" }} />

        {/* Toast */}
        {toast && (
          <div style={{ position:"fixed", top:18, right:18, zIndex:200,
            background:"rgba(6,182,212,0.18)", border:"1px solid #06b6d440",
            borderRadius:10, padding:"11px 20px", fontSize:13,
            fontFamily:"monospace", color:"#06b6d4", animation:"slideIn 0.3s ease" }}>
            {toast}
          </div>
        )}

        {/* Deposit modal */}
        {depModal && (
          <div style={ov} onClick={() => setDepMod(null)}>
            <div style={mod} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:16, color:"#06b6d4" }}>
                Deposit {depModal.symbol}
              </div>
              <div style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", marginBottom:10 }}>
                Live price: {depModal.price != null ? fmtUSD(depModal.price) : "loading…"}
              </div>
              <input style={inp} type="number" min="0" step="any"
                placeholder={`Amount in ${depModal.symbol}`}
                value={depAmt} onChange={e => setDepAmt(e.target.value)} />
              <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:16 }}>
                ≈ {depAmt && depModal.price ? fmtUSD(parseFloat(depAmt)*depModal.price) : "$0.00"} USD
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button style={btn("#06b6d4",true)} onClick={handleDeposit}>CONFIRM</button>
                <button style={btn("#ef4444")} onClick={() => setDepMod(null)}>✕</button>
              </div>
            </div>
          </div>
        )}

        {/* Add coin modal */}
        {addModal && (
          <div style={ov} onClick={() => setAddMod(false)}>
            <div style={mod} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:6, color:"#06b6d4" }}>Add Coin</div>
              <div style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", marginBottom:14 }}>
                Ticker symbol (e.g. AVAX, DOT, ADA, LINK)
              </div>
              <input style={inp} placeholder="Ticker (e.g. AVAX)"
                value={newCoin.symbol} onChange={e => setNewCoin(p=>({...p,symbol:e.target.value.toUpperCase()}))} />
              <input style={inp} placeholder="Name (e.g. Avalanche)"
                value={newCoin.name} onChange={e => setNewCoin(p=>({...p,name:e.target.value}))} />
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
                <span style={{ fontSize:12, color:"#64748b", fontFamily:"monospace" }}>Color:</span>
                <input type="color" value={newCoin.color}
                  onChange={e => setNewCoin(p=>({...p,color:e.target.value}))}
                  style={{ width:36, height:28, border:"none", background:"none", cursor:"pointer" }} />
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button style={btn("#06b6d4",true)} onClick={handleAddCoin}>ADD</button>
                <button style={btn("#ef4444")} onClick={() => setAddMod(false)}>✕</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Main ── */}
        <div style={{ position:"relative", zIndex:1, maxWidth:1140, margin:"0 auto", padding:"22px 18px" }}>

          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:42, height:42, borderRadius:11,
                background:"linear-gradient(135deg,#06b6d4,#9945FF)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:22, boxShadow:"0 0 22px rgba(6,182,212,0.4)" }}>⬡</div>
              <div>
                <div style={{ fontSize:21, fontWeight:800,
                  background:"linear-gradient(90deg,#06b6d4,#a78bfa)",
                  WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
                  MIDNIGHT VAULT
                </div>
                <div style={{ fontSize:10, color:"#334155", letterSpacing:2, fontFamily:"monospace" }}>
                  TESTNET · COMPACT ZK · REAL-TIME
                </div>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <button style={btn("#6366f1")} onClick={() => { pxTimer.current=0; fgTimer.current=0; loadFG(); loadPrices(allSyms); }}>↻ REFRESH</button>
              <button style={{ padding:"9px 18px", borderRadius:8, border:"1px solid #06b6d4",
                background:connected?"rgba(6,182,212,0.12)":"transparent",
                color:connected?"#06b6d4":"#94a3b8", cursor:"pointer", fontSize:12,
                fontFamily:"monospace", letterSpacing:1, display:"flex", alignItems:"center", gap:8 }}
                onClick={handleConnect} disabled={connected||connecting}>
                <span style={{ width:7, height:7, borderRadius:"50%", display:"inline-block",
                  background:connected?"#22c55e":connecting?"#eab308":"#475569",
                  boxShadow:connected?"0 0 8px #22c55e":"none" }} />
                {connecting?"CONNECTING…":connected?"MIDNIGHT TESTNET":"CONNECT WALLET"}
              </button>
            </div>
          </div>

          {/* KPIs */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:12, marginBottom:18 }}>
            {[
              { l:"VAULT VALUE",    v:fmtUSD(totalUSD),                                                                                       c:"#06b6d4" },
              { l:"FEAR & GREED",   v:fg.value!=null?`${fg.value} · ${fgInfo.label}`:fg.status==="loading"?"Loading…":"—",                    c:fgInfo.color },
              { l:"ACTIVE STRATEGY",v:activeStrat?.name || "—",                                                                               c:"#a78bfa" },
              { l:"AUTO-INVEST",    v:autoInvest?"ACTIVE":"PAUSED",                                                                           c:autoInvest?"#22c55e":"#ef4444" },
            ].map(k => (
              <div key={k.l} style={cg(k.c)}>
                <div style={lbl}>{k.l}</div>
                <div style={{ fontSize:15, fontWeight:800, color:k.c, fontFamily:"monospace",
                  wordBreak:"break-word", textShadow:`0 0 10px ${k.c}50` }}>{k.v}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div style={{ display:"flex", gap:4, marginBottom:18,
            background:"rgba(255,255,255,0.03)", borderRadius:10, padding:4,
            border:"1px solid rgba(255,255,255,0.07)" }}>
            {TABS.map(([id,lb]) => (
              <button key={id} style={tabSt(tab===id)} onClick={() => setTab(id)}>{lb}</button>
            ))}
          </div>

          {/* ─────────────────── VAULT TAB ─────────────────── */}
          {tab === "vault" && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>

              {/* F&G gauge — full-width redesign */}
              <div style={{ ...cg(fgInfo.color), gridColumn:"span 2" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={lbl}>FEAR &amp; GREED INDEX</div>
                    <span style={{ fontSize:9, color:"#475569", fontFamily:"monospace", padding:"2px 8px",
                      borderRadius:20, border:"1px solid rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.03)" }}>
                      via alternative.me
                    </span>
                  </div>
                  <StatusDot color={fg.status==="ok"?fgInfo.color:fg.status==="loading"?"#eab308":"#ef4444"}
                    text={fg.status==="ok"?`LIVE · ${liveClock}`:fg.status==="loading"?"FETCHING…":"ERROR"} />
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"230px 1fr", gap:24, alignItems:"start" }}>
                  {/* Left: Gauge */}
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
                    <FGGauge value={fg.value} />
                  </div>

                  {/* Right: Historical + Sparkline + Signal */}
                  <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

                    {/* Historical Values Row */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                      {[
                        { label:"YESTERDAY", data: fg.yesterday },
                        { label:"LAST WEEK", data: fg.lastWeek },
                        { label:"LAST MONTH", data: fg.lastMonth },
                      ].map(item => {
                        const info = item.data ? getFGInfo(item.data.value) : { label:"—", color:"#475569", bg:"rgba(100,116,139,0.08)" };
                        const val  = item.data?.value;
                        const diff = (fg.value != null && val != null) ? fg.value - val : null;
                        return (
                          <div key={item.label} style={{
                            padding:"12px 14px", borderRadius:10,
                            background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.06)",
                            position:"relative", overflow:"hidden"
                          }}>
                            {/* Subtle accent line at top */}
                            <div style={{ position:"absolute", top:0, left:0, right:0, height:2,
                              background:`linear-gradient(90deg, ${info.color}80, transparent)` }} />
                            <div style={{ fontSize:9, letterSpacing:2, color:"#475569", fontFamily:"monospace", marginBottom:8 }}>
                              {item.label}
                            </div>
                            <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:4 }}>
                              <span style={{ fontSize:26, fontWeight:800, fontFamily:"monospace", color:info.color,
                                textShadow:`0 0 14px ${info.color}40` }}>
                                {val ?? "—"}
                              </span>
                              {diff != null && (
                                <span style={{ fontSize:11, fontWeight:700, fontFamily:"monospace",
                                  color: diff > 0 ? "#22c55e" : diff < 0 ? "#ef4444" : "#475569",
                                  display:"flex", alignItems:"center", gap:2,
                                  padding:"2px 7px", borderRadius:6,
                                  background: diff > 0 ? "rgba(34,197,94,0.1)" : diff < 0 ? "rgba(239,68,68,0.1)" : "rgba(100,116,139,0.08)",
                                }}>
                                  {diff > 0 ? "▲" : diff < 0 ? "▼" : "="}{Math.abs(diff)}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize:11, fontWeight:700, color:info.color }}>
                              {item.data?.label || info.label}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Sparkline + Signal row */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      {/* Sparkline */}
                      <div style={{ padding:"12px 14px", borderRadius:10,
                        background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ fontSize:9, letterSpacing:2, color:"#475569", fontFamily:"monospace", marginBottom:8 }}>
                          15-DAY TREND
                        </div>
                        <Sparkline data={fg.history} color={fgInfo.color} w={220} h={48} />
                        <div style={{ display:"flex", justifyContent:"space-between", marginTop:6,
                          fontSize:9, color:"#334155", fontFamily:"monospace" }}>
                          <span>15d ago</span>
                          <span>Today</span>
                        </div>
                      </div>
                      {/* Signal */}
                      <div style={{ padding:"12px 14px", borderRadius:10,
                        background:fgInfo.bg, border:`1px solid ${fgInfo.color}25`,
                        display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
                        <div>
                          <div style={{ fontSize:9, letterSpacing:2, color:fgInfo.color, fontFamily:"monospace", marginBottom:6 }}>
                            STRATEGY SIGNAL
                          </div>
                          <div style={{ fontSize:20, fontWeight:800, color:fgInfo.color, marginBottom:4 }}>
                            {activeAlloc.action}
                          </div>
                          <div style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", lineHeight:1.5 }}>
                            {activeAlloc.desc || "Auto-rebalancing based on current market sentiment zone."}
                          </div>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:10 }}>
                          <div style={{ width:6, height:6, borderRadius:"50%", background:fgInfo.color,
                            boxShadow:`0 0 8px ${fgInfo.color}`, animation:"blink 2s infinite" }} />
                          <span style={{ fontSize:9, color:"#475569", fontFamily:"monospace" }}>
                            {activeStrat?.name} · Zone {fg.value != null ? zoneOf(fg.value) + 1 : "—"}/5
                          </span>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>

              {/* Allocation */}
              <div style={{ ...card, gridColumn:"span 2" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div style={lbl}>ALLOCATION · {activeStrat?.name?.toUpperCase()}</div>
                  <span style={{ fontSize:10, color:"#a78bfa", fontFamily:"monospace", padding:"2px 8px",
                    borderRadius:20, border:"1px solid #a78bfa40", background:"#a78bfa15" }}>
                    {activeStrat?.isBuiltin ? "BUILT-IN" : "CUSTOM"}
                  </span>
                </div>
                <div style={{ marginBottom:14 }}>
                  <AllocBar btc={activeAlloc.btc} eth={activeAlloc.eth}
                    sol={activeAlloc.sol} other={activeAlloc.other} />
                </div>
                <div style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", lineHeight:1.75, marginBottom:12 }}>
                  {activeAlloc.action} — {activeAlloc.desc || "Executing strategy…"}
                </div>
                {rebal && (
                  <div style={{ display:"flex", alignItems:"center", gap:8,
                    color:"#06b6d4", fontSize:11, fontFamily:"monospace" }}>
                    <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>⟳</span>
                    GENERATING ZK PROOF…
                  </div>
                )}
              </div>

              {/* Holdings */}
              <div style={{ ...card, gridColumn:"span 2" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={lbl}>HOLDINGS</div>
                    <StatusDot color={pxStatus==="ok"?"#22c55e":pxStatus==="loading"?"#eab308":"#ef4444"}
                      text={pxStatus==="ok"?`LIVE · ${liveClock}`:pxStatus==="loading"?"FETCHING…":"ERROR"} />
                  </div>
                  <button style={btn("#06b6d4")} onClick={() => setAddMod(true)}>+ ADD COIN</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"36px 1fr 120px 100px 110px 70px",
                  gap:10, padding:"0 0 8px", borderBottom:"1px solid rgba(255,255,255,0.06)",
                  fontSize:10, color:"#334155", fontFamily:"monospace", letterSpacing:1 }}>
                  <div/><div>ASSET</div>
                  <div style={{textAlign:"right"}}>LIVE PRICE</div>
                  <div style={{textAlign:"right"}}>24H %</div>
                  <div style={{textAlign:"right"}}>BALANCE</div>
                  <div/>
                </div>
                {allAssets.map(a => {
                  const usd = a.balance*(a.price??0);
                  const pct = totalUSD>0?(usd/totalUSD*100):0;
                  const isC = custom.some(c=>c.id===a.id);
                  const chCol = a.change==null?"#64748b":a.change>=0?"#22c55e":"#ef4444";
                  return (
                    <div key={a.id} style={{ display:"grid",
                      gridTemplateColumns:"36px 1fr 120px 100px 110px 70px",
                      gap:10, alignItems:"center", padding:"12px 0",
                      borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
                      <div style={{ width:34,height:34,borderRadius:9,
                        background:`${a.color}1a`,border:`1px solid ${a.color}45`,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        color:a.color,fontSize:10,fontWeight:800,fontFamily:"monospace" }}>
                        {a.symbol.slice(0,3)}
                      </div>
                      <div>
                        <div style={{ fontWeight:700,fontSize:14 }}>{a.name}</div>
                        <div style={{ marginTop:4,background:"rgba(255,255,255,0.04)",borderRadius:3,height:3 }}>
                          <div style={{ width:`${pct}%`,height:"100%",background:a.color,transition:"width 0.8s ease" }} />
                        </div>
                        <div style={{ fontSize:10,color:"#334155",fontFamily:"monospace",marginTop:2 }}>
                          {pct.toFixed(1)}% of vault
                        </div>
                      </div>
                      <div style={{ textAlign:"right",fontFamily:"monospace",fontSize:14,fontWeight:700 }}>
                        {a.price!=null?fmtUSD(a.price):<span style={{color:"#334155",fontSize:12}}>{pxStatus==="loading"?"…":"—"}</span>}
                      </div>
                      <div style={{ textAlign:"right",fontFamily:"monospace",fontSize:13,color:chCol,fontWeight:600 }}>
                        {a.change!=null?`${a.change>=0?"+":""}${Number(a.change).toFixed(2)}%`:"—"}
                      </div>
                      <div style={{ textAlign:"right",fontFamily:"monospace",fontSize:12 }}>
                        {a.balance>0?<><div>{a.balance} {a.symbol}</div><div style={{color:"#334155",fontSize:11}}>{fmtUSD(usd)}</div></>:<span style={{color:"#334155"}}>—</span>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        {!isC&&<button style={{...btn(a.color),padding:"6px 12px",fontSize:12}}
                          onClick={()=>connected?setDepMod(a):notify("Connect wallet first")}>+</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─────────────────── STRATEGY TAB ─────────────────── */}
          {tab === "invest" && (
            <div style={{ display:"grid", gap:16 }}>
              {/* Active strategy banner */}
              <div style={{ ...cg("#a78bfa"), display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={lbl}>ACTIVE STRATEGY</div>
                  <div style={{ fontSize:18, fontWeight:800, color:"#a78bfa" }}>{activeStrat?.name}</div>
                  <div style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", marginTop:3 }}>
                    {activeStrat?.desc || "Rebalances automatically based on the Fear & Greed Index"}
                  </div>
                </div>
                <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                  <button style={btn(autoInvest?"#ef4444":"#22c55e")}
                    onClick={() => { setAI(v=>!v); notify(autoInvest?"⏸ Paused":"▶ Activated"); }}>
                    {autoInvest?"PAUSE":"ACTIVATE"}
                  </button>
                  <button style={btn("#a78bfa")} onClick={openNewStrategy}>+ NEW STRATEGY</button>
                </div>
              </div>

              {/* All strategies */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:14 }}>
                {strategies.map(s => {
                  const isActive = s.id === activeStratId;
                  return (
                    <div key={s.id} style={{ ...cg(isActive?"#a78bfa":"#ffffff"),
                      opacity: isActive?1:0.65, transition:"all 0.3s",
                      cursor:"pointer" }}
                      onClick={() => { setActiveSId(s.id); notify(`✓ Switched to "${s.name}"`); }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                        <div>
                          <div style={{ fontSize:10, color: isActive?"#a78bfa":"#475569",
                            fontFamily:"monospace", letterSpacing:2, marginBottom:4 }}>
                            {s.isBuiltin ? "BUILT-IN" : "CUSTOM"}
                            {isActive && " · ACTIVE"}
                          </div>
                          <div style={{ fontSize:16, fontWeight:800, color:isActive?"#a78bfa":"#e2e8f0" }}>
                            {s.name}
                          </div>
                        </div>
                        <div style={{ display:"flex", gap:6 }}>
                          <button style={{ ...btn("#6366f1"), padding:"5px 10px", fontSize:11 }}
                            onClick={e => { e.stopPropagation(); openEditStrategy(s); }}>EDIT</button>
                          {!s.isBuiltin && (
                            <button style={{ ...btn("#ef4444"), padding:"5px 10px", fontSize:11 }}
                              onClick={e => { e.stopPropagation(); deleteStrategy(s.id); }}>✕</button>
                          )}
                        </div>
                      </div>
                      {/* mini zone preview */}
                      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                        {s.zones.map(z => (
                          <div key={z.id} style={{ display:"flex", justifyContent:"space-between",
                            alignItems:"center", fontSize:11, fontFamily:"monospace" }}>
                            <span style={{ color:z.color }}>{z.name}</span>
                            <span style={{ color:"#475569" }}>
                              BTC {z.btc}% · ETH {z.eth}% · SOL {z.sol}% · OTHER {z.other}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─────────────────── BUILD / EDIT STRATEGY TAB ─────────────────── */}
          {tab === "strategy" && (
            <div style={{ display:"grid", gridTemplateColumns:"300px 1fr", gap:16, alignItems:"start" }}>

              {/* Left: meta + zone selector */}
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                {/* Name & desc */}
                <div style={card}>
                  <div style={lbl}>STRATEGY DETAILS</div>
                  <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:8 }}>Name</div>
                  <input style={inp} placeholder="e.g. Degen Mode"
                    value={stratEditor?.name || ""}
                    onChange={e => setStratEditor(p=>({...p,name:e.target.value}))} />
                  <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:8 }}>Description (optional)</div>
                  <input style={{...inp,marginBottom:0}} placeholder="Brief description…"
                    value={stratEditor?.desc || ""}
                    onChange={e => setStratEditor(p=>({...p,desc:e.target.value}))} />
                </div>

                {/* Zone selector */}
                <div style={card}>
                  <div style={lbl}>SELECT ZONE TO EDIT</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    {(stratEditor?.zones || []).map((z, i) => {
                      const active = editingZoneIdx === i;
                      const sum = z.btc+z.eth+z.sol+z.other;
                      const ok = Math.abs(sum-100) <= 0.5;
                      return (
                        <button key={z.id}
                          style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                            padding:"10px 14px", borderRadius:9, border:`1px solid ${active?z.color:"rgba(255,255,255,0.08)"}`,
                            background: active?`${z.color}15`:"rgba(255,255,255,0.02)",
                            color:active?z.color:"#94a3b8", cursor:"pointer",
                            fontFamily:"monospace", fontSize:12, textAlign:"left", transition:"all 0.2s" }}
                          onClick={() => setEditZone(i)}>
                          <div>
                            <div style={{ fontWeight:700, fontSize:13, color:active?z.color:"#e2e8f0" }}>{z.name}</div>
                            <div style={{ fontSize:10, marginTop:2 }}>F&G {z.lo}–{z.hi}</div>
                          </div>
                          <div style={{ textAlign:"right" }}>
                            <div style={{ fontSize:11, color:ok?"#22c55e":"#ef4444" }}>{sum}%</div>
                            <div style={{ fontSize:9, color:"#475569" }}>sum</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Live preview */}
                <div style={cg(fgInfo.color)}>
                  <div style={lbl}>LIVE PREVIEW</div>
                  <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:8 }}>
                    F&G = {fg.value ?? "—"} ({fgInfo.label})
                  </div>
                  {(() => {
                    const zone = editingZoneIdx != null && stratEditor?.zones[editingZoneIdx];
                    return zone ? <AllocBar btc={zone.btc} eth={zone.eth} sol={zone.sol} other={zone.other} /> : null;
                  })()}
                </div>
              </div>

              {/* Right: allocation editor for selected zone */}
              {stratEditor && editingZoneIdx != null && (() => {
                const z     = stratEditor.zones[editingZoneIdx];
                const sum   = z.btc + z.eth + z.sol + z.other;
                const ok    = Math.abs(sum - 100) <= 0.5;
                const isActive = fg.value != null && fg.value >= z.lo && fg.value <= z.hi;
                return (
                  <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                    {/* Zone header */}
                    <div style={cg(z.color)}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                        <div>
                          <div style={{ fontSize:10, color:z.color, fontFamily:"monospace", letterSpacing:2 }}>
                            ZONE · F&G {z.lo}–{z.hi} {isActive?"· ● LIVE NOW":""}
                          </div>
                          <div style={{ fontSize:22, fontWeight:800, color:z.color }}>{z.name}</div>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:26, fontWeight:800, fontFamily:"monospace",
                            color: ok?"#22c55e":"#ef4444" }}>{sum}%</div>
                          <div style={{ fontSize:10, color: ok?"#22c55e":"#ef4444", fontFamily:"monospace" }}>
                            {ok?"✓ VALID":"MUST = 100%"}
                          </div>
                        </div>
                      </div>
                      <AllocBar btc={z.btc} eth={z.eth} sol={z.sol} other={z.other} />
                    </div>

                    {/* Sliders */}
                    <div style={card}>
                      <div style={lbl}>ALLOCATION SLIDERS</div>
                      <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:14 }}>
                        Drag a slider — others auto-adjust to keep total at 100%
                      </div>

                      {[
                        { field:"btc",   label:"Bitcoin (BTC)",  color:"#F7931A" },
                        { field:"eth",   label:"Ethereum (ETH)", color:"#627EEA" },
                        { field:"sol",   label:"Solana (SOL)",   color:"#9945FF" },
                        { field:"other", label:"Other Assets",   color:"#06b6d4" },
                      ].map(({ field, label, color }) => (
                        <AllocSlider key={field} label={label} color={color}
                          value={z[field]}
                          onChange={val => normalizeAlloc(editingZoneIdx, field, val)} />
                      ))}
                    </div>

                    {/* Action label */}
                    <div style={card}>
                      <div style={lbl}>ACTION LABEL (optional)</div>
                      <input style={inp}
                        placeholder={`e.g. ${z.action}`}
                        value={z.action}
                        onChange={e => updateZoneAlloc(editingZoneIdx, "action", e.target.value)} />
                      <div style={lbl}>DESCRIPTION (optional)</div>
                      <textarea style={{ ...inp, height:80, resize:"vertical", marginBottom:0 }}
                        placeholder="Describe this zone's strategy…"
                        value={z.desc || ""}
                        onChange={e => updateZoneAlloc(editingZoneIdx, "desc", e.target.value)} />
                    </div>

                    {/* Quick presets */}
                    <div style={card}>
                      <div style={lbl}>QUICK PRESETS FOR THIS ZONE</div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                        {[
                          { label:"DEGEN",      btc:20, eth:20, sol:40, other:20 },
                          { label:"BALANCED",   btc:25, eth:25, sol:25, other:25 },
                          { label:"BTC MAXI",   btc:70, eth:15, sol:10, other:5  },
                          { label:"ETH HEAVY",  btc:20, eth:55, sol:15, other:10 },
                          { label:"SAFE",       btc:50, eth:30, sol:10, other:10 },
                          { label:"ALT HEAVY",  btc:15, eth:25, sol:35, other:25 },
                        ].map(p => (
                          <button key={p.label}
                            style={{ padding:"8px 4px", borderRadius:8, fontSize:11,
                              fontFamily:"monospace", fontWeight:700, cursor:"pointer",
                              border:"1px solid rgba(255,255,255,0.1)",
                              background:"rgba(255,255,255,0.03)", color:"#94a3b8",
                              transition:"all 0.2s", letterSpacing:0.5 }}
                            onClick={() => {
                              setStratEditor(prev => {
                                const zones = prev.zones.map((z, i) => i === editingZoneIdx
                                  ? {...z, btc:p.btc, eth:p.eth, sol:p.sol, other:p.other} : z);
                                return {...prev, zones};
                              });
                            }}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Save / Cancel */}
                    <div style={{ display:"flex", gap:12 }}>
                      <button style={{ ...btn("#22c55e",true), padding:"12px 0", fontSize:14, fontWeight:700 }}
                        onClick={saveStrategy}>
                        ✓ SAVE &amp; ACTIVATE STRATEGY
                      </button>
                      <button style={{ ...btn("#ef4444"), padding:"12px 20px" }}
                        onClick={() => { setStratEditor(null); setTab("invest"); }}>
                        CANCEL
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ─────────────────── ACTIVITY TAB ─────────────────── */}
          {tab === "activity" && (
            <div style={card}>
              <div style={lbl}>TRANSACTION LOG · MIDNIGHT TESTNET</div>
              {txLog.length === 0 ? (
                <div style={{ textAlign:"center", padding:"40px 0", color:"#334155",
                  fontFamily:"monospace", fontSize:12 }}>Connect wallet to see activity</div>
              ) : txLog.map(tx => {
                const tc = {connect:"#06b6d4",deposit:"#22c55e",rebalance:"#a78bfa",withdraw:"#f97316"}[tx.type]||"#94a3b8";
                return (
                  <div key={tx.id} style={{ padding:"12px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:8,height:8,borderRadius:"50%",background:tc,boxShadow:`0 0 7px ${tc}`,flexShrink:0 }}/>
                        <span style={{ fontSize:13, fontWeight:600 }}>{tx.desc}</span>
                      </div>
                      <span style={{ fontSize:11, color:"#334155", fontFamily:"monospace" }}>{tx.time}</span>
                    </div>
                    <div style={{ display:"flex", gap:16, paddingLeft:18, marginTop:4 }}>
                      <span style={{ fontSize:10, color:"#334155", fontFamily:"monospace" }}>TX: {tx.hash}</span>
                      <span style={{ fontSize:10, color:"#334155", fontFamily:"monospace" }}>BLOCK #{tx.block}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop:20, textAlign:"center", fontSize:10,
            color:"#1a2233", fontFamily:"monospace", letterSpacing:2 }}>
            MIDNIGHT VAULT · TESTNET ONLY · NOT FINANCIAL ADVICE
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slideIn { from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)} }
        @keyframes spin    { from{transform:rotate(0deg)}to{transform:rotate(360deg)} }
        @keyframes blink   { 0%,100%{opacity:1}50%{opacity:0.3} }
        @keyframes pulse   { 0%{box-shadow:0 0 0 0 rgba(34,197,94,0.4)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)} }
        * { box-sizing:border-box; }
        button:hover { opacity:0.82; }
        textarea { font-family:monospace; color:#e2e8f0; }
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-thumb{background:rgba(6,182,212,0.3);border-radius:3px}
      `}</style>
    </>
  );
}
