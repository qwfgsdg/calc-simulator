import { useState, useCallback, useMemo, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════ */
const uid = () => Math.random().toString(36).slice(2, 9);
const COINS = ["ETH", "BTC", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK"];
const COINS_PRIMARY = ["ETH", "BTC", "SOL", "XRP"];  // 버튼으로 표시
const COINS_MORE = ["DOGE", "ADA", "AVAX", "LINK"];   // 더보기
const LEV_PRESETS = [5, 10, 20, 25, 50, 75, 100, 125];

const n = (v) => Number(v) || 0;
const fmt = (v, d = 2) =>
  v != null && isFinite(v)
    ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";
const fmtS = (v, d = 2) => (v >= 0 ? "+" : "") + fmt(v, d);
const pct = (a, b) => (b !== 0 ? (a / b) * 100 : 0);

// ── 투입금액 ↔ 표시마진 변환 (Tapbit USDT 무기한) ──
const COIN_QTY_STEPS = {
  BTC: 0.001, ETH: 0.01, SOL: 0.1, XRP: 1,
  DOGE: 1, ADA: 1, AVAX: 0.1, LINK: 0.1,
};

function fromInput(input, entry, lev, fee, dir, coin) {
  if (!input || !entry || !lev) return null;
  const step = COIN_QTY_STEPS[coin] || 0.001;
  const bkPrice = dir === "long"
    ? entry * (lev - 1) / lev
    : entry * (lev + 1) / lev;
  const costPerQty = entry / lev + entry * fee + bkPrice * fee;
  if (costPerQty <= 0) return null;
  const rawQty = input / costPerQty;
  const qty = Math.floor(rawQty / step) * step;
  if (qty <= 0) return null;
  const size = qty * entry;
  const margin = size / lev;
  const openCost = size * fee;
  const closeCost = qty * bkPrice * fee;
  return { margin, qty, size, openCost, closeCost,
           total: margin + openCost + closeCost,
           change: input - (margin + openCost + closeCost), bkPrice };
}

function fromDisplay(margin, entry, lev, fee, dir) {
  if (!margin || !entry || !lev) return margin;
  const qty = margin * lev / entry;
  const bkPrice = dir === "long"
    ? entry * (lev - 1) / lev
    : entry * (lev + 1) / lev;
  return margin + qty * entry * fee + qty * bkPrice * fee;
}

/* ═══════════════════════════════════════════
   DATA FACTORIES
   ═══════════════════════════════════════════ */
const mkPos = (ov = {}) => ({
  id: uid(), dir: "long", coin: "ETH",
  entryPrice: "", margin: "", leverage: 50, ...ov,
});
const mkDCA = () => ({ id: uid(), price: "", margin: "" });
const mkPyra = () => ({ id: uid(), price: "", margin: "" });

/* ═══════════════════════════════════════════
   PERSISTENT STORAGE (MULTI-PROFILE)
   ═══════════════════════════════════════════ */
const STORAGE_KEY_LEGACY = "simv4-data";
const STORAGE_KEY_PROFILES = "simv4-profiles";
const STORAGE_KEY_ACTIVE = "simv4-active-profile";
const profileDataKey = (id) => `simv4-data-${id}`;

const PROFILE_COLORS = [
  { id: "emerald", hex: "#34d399", label: "에메랄드" },
  { id: "sky",     hex: "#0ea5e9", label: "스카이" },
  { id: "violet",  hex: "#a78bfa", label: "바이올렛" },
  { id: "amber",   hex: "#f59e0b", label: "앰버" },
  { id: "rose",    hex: "#f87171", label: "로즈" },
  { id: "pink",    hex: "#ec4899", label: "핑크" },
  { id: "lime",    hex: "#84cc16", label: "라임" },
  { id: "cyan",    hex: "#22d3ee", label: "시안" },
];

const mkProfile = (name = "기본 프로필", colorId = "emerald") => ({
  id: uid(),
  name,
  colorId,
  createdAt: Date.now(),
  lastUsed: Date.now(),
});

const storageAdapter = {
  async save(key, data) {
    const json = JSON.stringify(data);
    try {
      if (window.storage) {
        await window.storage.set(key, json);
        return true;
      } else if (window.localStorage) {
        localStorage.setItem(key, json);
        return true;
      }
    } catch (e) { console.warn("Storage save failed:", e); }
    return false;
  },
  async load(key) {
    try {
      if (window.storage) {
        const result = await window.storage.get(key);
        return result ? JSON.parse(result.value) : null;
      } else if (window.localStorage) {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }
    } catch (e) { console.warn("Storage load failed:", e); }
    return null;
  },
  async clear(key) {
    try {
      if (window.storage) { await window.storage.delete(key); }
      else if (window.localStorage) { localStorage.removeItem(key); }
    } catch (e) { console.warn("Storage clear failed:", e); }
  },
};

/* ═══════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════ */
export default function SimV4() {
  const [wallet, setWallet] = useState("");
  const [coinPrices, setCoinPrices] = useState({}); // { ETH: "2647.35", BTC: "97340" }
  const [feeRate, setFeeRate] = useState("0.04");
  const [coinLiqPrices, setCoinLiqPrices] = useState({}); // 코인별 거래소 청산가
  const setLiqPrice = (coin, val) => setCoinLiqPrices(prev => ({ ...prev, [coin]: val }));
  const getLiqPrice = (coin) => n(coinLiqPrices[coin] || "");

  // ── 실시간 가격 ──
  const [priceMode, setPriceMode] = useState("manual"); // "live" | "manual"
  const [lastFetch, setLastFetch] = useState(null);
  const [priceDir, setPriceDir] = useState(null); // "up" | "down" | null
  const [fetchError, setFetchError] = useState(false);
  const priceDirTimer = useRef(null);

  const [positions, setPositions] = useState([
    mkPos(),
  ]);

  const [selId, setSelId] = useState(null);
  const [dcaMode, setDcaMode] = useState("sim");
  const [dcaEntries, setDcaEntries] = useState([mkDCA()]);
  const [revPrice, setRevPrice] = useState("");
  const [revTarget, setRevTarget] = useState("");
  const [targetAvail, setTargetAvail] = useState("");
  const [closeRatio, setCloseRatio] = useState("50");
  const [closePrice, setClosePrice] = useState("");
  const [splitMode, setSplitMode] = useState(false);
  const [splitTotal, setSplitTotal] = useState("");
  const [splitPrices, setSplitPrices] = useState(["", "", ""]);

  // ── Pyramiding (불타기) state ──
  const [pyraMode, setPyraMode] = useState(false);
  const [pyraLockedId, setPyraLockedId] = useState(null);
  const [pyraCounterId, setPyraCounterId] = useState(null);
  const [pyraSubMode, setPyraSubMode] = useState("sim");
  const [pyraEntries, setPyraEntries] = useState([mkPyra()]);
  const [pyraRevPrice, setPyraRevPrice] = useState("");
  const [pyraRevTarget, setPyraRevTarget] = useState("");
  const [pyraSplitMode, setPyraSplitMode] = useState(false);
  const [pyraSplitTotal, setPyraSplitTotal] = useState("");
  const [pyraSplitPrices, setPyraSplitPrices] = useState(["", "", ""]);

  // ── 동시청산 계산기 ──
  const [scCloseRatios, setScCloseRatios] = useState({}); // { ETH: { long: "100", short: "100" } }
  const [scTargets, setScTargets] = useState({}); // { ETH: "50" }
  const getScRatio = (coin, dir) => scCloseRatios[coin]?.[dir] || "100";
  const setScRatio = (coin, dir, val) => setScCloseRatios(prev => ({ ...prev, [coin]: { ...(prev[coin] || {}), [dir]: val } }));
  const getScTarget = (coin) => scTargets[coin] || "";
  const setScTarget = (coin, val) => setScTargets(prev => ({ ...prev, [coin]: val }));

  // ── 헷지 사이클 전략 ──
  const [appTab, setAppTab] = useState("sim"); // "sim" | "hedge"
  const [hcMargin, setHcMargin] = useState("1000");         // 한쪽 기본 마진
  const [hcLeverage, setHcLeverage] = useState("100");       // 레버리지
  const [hcTakeROE, setHcTakeROE] = useState("40");          // 익절 ROE %
  const [hcCutRatio, setHcCutRatio] = useState("50");        // 손절 비율 %
  const [hcRecoveryROE, setHcRecoveryROE] = useState("0");   // 복구 ROE %
  const [hcKillPct, setHcKillPct] = useState("15");          // 킬 스위치 %
  const [hcLongEntry, setHcLongEntry] = useState("");        // 롱 진입가
  const [hcShortEntry, setHcShortEntry] = useState("");      // 숏 진입가
  const [hcLongMargin, setHcLongMargin] = useState("");      // 롱 현재 마진
  const [hcShortMargin, setHcShortMargin] = useState("");    // 숏 현재 마진
  const [hcCycles, setHcCycles] = useState([]);              // 사이클 히스토리

  // ── 사용 중인 코인 자동 감지 ──
  const usedCoins = useMemo(() => [...new Set(positions.map(p => p.coin))].sort(), [positions]);
  const getCp = (coin) => n(coinPrices[coin] || "");
  const setCp = (coin, val) => setCoinPrices(prev => ({ ...prev, [coin]: val }));
  const primaryCoin = usedCoins[0] || "ETH";
  const hasAnyPrice = usedCoins.some(c => getCp(c) > 0);

  const [saveStatus, setSaveStatus] = useState(null); // "saved" | "saving" | null
  const [dataLoaded, setDataLoaded] = useState(false);
  const saveTimer = useRef(null);

  // ── 멀티 프로필 시스템 ──
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [profileModal, setProfileModal] = useState(null); // null | "create" | "rename"
  const [profileModalName, setProfileModalName] = useState("");
  const [profileModalColor, setProfileModalColor] = useState("emerald");
  const profileDropdownRef = useRef(null);
  const activeProfile = profiles.find(p => p.id === activeProfileId);
  const activeColor = PROFILE_COLORS.find(c => c.id === (activeProfile?.colorId || "emerald"))?.hex || "#34d399";

  // ── 프로필 데이터를 state에 적용하는 헬퍼 ──
  const applyProfileData = (data) => {
    if (!data) return;
    if (data.wallet != null) setWallet(data.wallet);
    if (data.feeRate != null) setFeeRate(data.feeRate);
    if (data.coinLiqPrices) setCoinLiqPrices(data.coinLiqPrices);
    else if (data.exLiqPrice != null) setCoinLiqPrices({ ETH: data.exLiqPrice });
    if (data.coinPrices) setCoinPrices(data.coinPrices);
    else if (data.priceCoin) setCoinPrices({});
    if (data.positions && data.positions.length > 0) {
      setPositions(data.positions.map((p) => ({ ...mkPos(), ...p, id: p.id || uid() })));
    } else {
      setPositions([mkPos()]);
    }
    if (data.hcMargin != null) setHcMargin(data.hcMargin);
    if (data.hcLeverage != null) setHcLeverage(data.hcLeverage);
    if (data.hcTakeROE != null) setHcTakeROE(data.hcTakeROE);
    if (data.hcCutRatio != null) setHcCutRatio(data.hcCutRatio);
    if (data.hcRecoveryROE != null) setHcRecoveryROE(data.hcRecoveryROE);
    if (data.hcKillPct != null) setHcKillPct(data.hcKillPct);
    if (data.hcLongEntry != null) setHcLongEntry(data.hcLongEntry);
    if (data.hcShortEntry != null) setHcShortEntry(data.hcShortEntry);
    if (data.hcLongMargin != null) setHcLongMargin(data.hcLongMargin);
    if (data.hcShortMargin != null) setHcShortMargin(data.hcShortMargin);
    if (data.hcCycles) setHcCycles(data.hcCycles);
  };

  const resetToDefaults = () => {
    setWallet(""); setFeeRate("0.04"); setCoinLiqPrices({}); setCoinPrices({});
    setPositions([mkPos()]); setSelId(null); setPyraMode(false);
    setHcMargin("1000"); setHcLeverage("100"); setHcTakeROE("40");
    setHcCutRatio("50"); setHcRecoveryROE("0"); setHcKillPct("15");
    setHcLongEntry(""); setHcShortEntry(""); setHcLongMargin("");
    setHcShortMargin(""); setHcCycles([]);
  };

  // ── 마운트 시 프로필 시스템 초기화 ──
  useEffect(() => {
    (async () => {
      let loadedProfiles = await storageAdapter.load(STORAGE_KEY_PROFILES);
      let targetId = null;

      if (!loadedProfiles || loadedProfiles.length === 0) {
        // 레거시 데이터 마이그레이션 체크
        const legacyData = await storageAdapter.load(STORAGE_KEY_LEGACY);
        const defaultProfile = mkProfile("기본 프로필", "emerald");
        loadedProfiles = [defaultProfile];

        if (legacyData) {
          // 기존 단일 저장 데이터를 첫 프로필로 마이그레이션
          await storageAdapter.save(profileDataKey(defaultProfile.id), legacyData);
          await storageAdapter.clear(STORAGE_KEY_LEGACY);
        }
        await storageAdapter.save(STORAGE_KEY_PROFILES, loadedProfiles);
        targetId = defaultProfile.id;
      } else {
        // 최근 사용 프로필 자동 선택
        const savedActiveId = await storageAdapter.load(STORAGE_KEY_ACTIVE);
        const lastUsedProfile = [...loadedProfiles].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
        targetId = savedActiveId && loadedProfiles.find(p => p.id === savedActiveId)
          ? savedActiveId
          : lastUsedProfile?.id || loadedProfiles[0].id;
      }

      setProfiles(loadedProfiles);
      setActiveProfileId(targetId);

      // 활성 프로필 데이터 로드
      const data = await storageAdapter.load(profileDataKey(targetId));
      if (data) applyProfileData(data);

      // lastUsed 업데이트
      const updatedProfiles = loadedProfiles.map(p =>
        p.id === targetId ? { ...p, lastUsed: Date.now() } : p
      );
      setProfiles(updatedProfiles);
      await storageAdapter.save(STORAGE_KEY_PROFILES, updatedProfiles);
      await storageAdapter.save(STORAGE_KEY_ACTIVE, targetId);

      setDataLoaded(true);
    })();
  }, []);

  // A등급 데이터 변경 시 1초 debounce 자동 저장 (활성 프로필에)
  useEffect(() => {
    if (!dataLoaded || !activeProfileId) return;
    clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(async () => {
      const data = {
        wallet, feeRate, coinLiqPrices, coinPrices,
        positions: positions.map((p) => ({
          id: p.id, dir: p.dir, coin: p.coin,
          entryPrice: p.entryPrice, margin: p.margin, leverage: p.leverage,
        })),
        hcMargin, hcLeverage, hcTakeROE, hcCutRatio, hcRecoveryROE, hcKillPct,
        hcLongEntry, hcShortEntry, hcLongMargin, hcShortMargin, hcCycles,
      };
      const ok = await storageAdapter.save(profileDataKey(activeProfileId), data);
      setSaveStatus(ok ? "saved" : null);
    }, 1000);
  }, [wallet, feeRate, coinLiqPrices, coinPrices, positions, dataLoaded, activeProfileId,
      hcMargin, hcLeverage, hcTakeROE, hcCutRatio, hcRecoveryROE, hcKillPct,
      hcLongEntry, hcShortEntry, hcLongMargin, hcShortMargin, hcCycles]);

  const handleReset = async () => {
    if (!confirm(`"${activeProfile?.name || "프로필"}"의 데이터를 초기화할까요?`)) return;
    if (activeProfileId) await storageAdapter.clear(profileDataKey(activeProfileId));
    resetToDefaults();
    setSaveStatus(null);
  };

  // ── 프로필 전환 ──
  const switchProfile = async (targetId, profilesOverride) => {
    if (targetId === activeProfileId && !profilesOverride) return;
    const currentProfiles = profilesOverride || profiles;
    // 현재 프로필 저장 (flush)
    clearTimeout(saveTimer.current);
    if (activeProfileId) {
      const curData = {
        wallet, feeRate, coinLiqPrices, coinPrices,
        positions: positions.map((p) => ({
          id: p.id, dir: p.dir, coin: p.coin,
          entryPrice: p.entryPrice, margin: p.margin, leverage: p.leverage,
        })),
        hcMargin, hcLeverage, hcTakeROE, hcCutRatio, hcRecoveryROE, hcKillPct,
        hcLongEntry, hcShortEntry, hcLongMargin, hcShortMargin, hcCycles,
      };
      await storageAdapter.save(profileDataKey(activeProfileId), curData);
    }
    // 대상 프로필 데이터 로드
    resetToDefaults();
    const data = await storageAdapter.load(profileDataKey(targetId));
    if (data) applyProfileData(data);

    // lastUsed 갱신
    const updatedProfiles = currentProfiles.map(p =>
      p.id === targetId ? { ...p, lastUsed: Date.now() } : p
    );
    setProfiles(updatedProfiles);
    setActiveProfileId(targetId);
    await storageAdapter.save(STORAGE_KEY_PROFILES, updatedProfiles);
    await storageAdapter.save(STORAGE_KEY_ACTIVE, targetId);
    setProfileDropdownOpen(false);
    setSelId(null); setPyraMode(false);
  };

  // ── 프로필 생성 ──
  const createProfile = async (name, colorId) => {
    const newP = mkProfile(name || `프로필 ${profiles.length + 1}`, colorId || "emerald");
    const updatedProfiles = [...profiles, newP];
    setProfiles(updatedProfiles);
    await storageAdapter.save(STORAGE_KEY_PROFILES, updatedProfiles);
    // 생성 후 바로 전환 (최신 배열 override)
    await switchProfile(newP.id, updatedProfiles);
  };

  // ── 프로필 이름/색상 변경 ──
  const renameProfile = async (id, newName, newColorId) => {
    const updatedProfiles = profiles.map(p =>
      p.id === id ? { ...p, name: newName || p.name, colorId: newColorId ?? p.colorId } : p
    );
    setProfiles(updatedProfiles);
    await storageAdapter.save(STORAGE_KEY_PROFILES, updatedProfiles);
  };

  // ── 프로필 삭제 ──
  const deleteProfile = async (id) => {
    if (profiles.length <= 1) { alert("최소 1개 프로필은 유지해야 합니다."); return; }
    if (!confirm(`"${profiles.find(p => p.id === id)?.name}"을(를) 삭제할까요?`)) return;
    await storageAdapter.clear(profileDataKey(id));
    const remaining = profiles.filter(p => p.id !== id);
    setProfiles(remaining);
    await storageAdapter.save(STORAGE_KEY_PROFILES, remaining);
    if (activeProfileId === id) {
      const next = [...remaining].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
      await switchProfile(next.id, remaining);
    }
  };

  // ── 드롭다운 외부 클릭 닫기 ──
  useEffect(() => {
    if (!profileDropdownOpen) return;
    const handler = (e) => {
      if (profileDropdownRef.current && !profileDropdownRef.current.contains(e.target)) {
        setProfileDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [profileDropdownOpen]);

  // ── 실시간 가격 fetch (다중 코인 · 적응형 주기) ──
  const intervalRef = useRef(null);
  const fetchRef = useRef(null);

  useEffect(() => {
    if (priceMode !== "live" || usedCoins.length === 0) return;
    const controller = new AbortController();
    let errCount = 0;

    const fetchPrices = async () => {
      try {
        const results = await Promise.all(
          usedCoins.map(coin =>
            fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${coin}USDT`, { signal: controller.signal })
              .then(r => r.json())
              .then(d => ({ coin, price: String(parseFloat(d.price)) }))
          )
        );
        errCount = 0;
        setFetchError(false);
        setCoinPrices(prev => {
          const next = { ...prev };
          let changed = false;
          results.forEach(({ coin, price }) => {
            if (next[coin] !== price) { next[coin] = price; changed = true; }
          });
          if (changed) {
            setPriceDir("up");
            clearTimeout(priceDirTimer.current);
            priceDirTimer.current = setTimeout(() => setPriceDir(null), 500);
          }
          return changed ? next : prev;
        });
        setLastFetch(Date.now());
      } catch (e) {
        if (e.name === "AbortError") return;
        errCount++;
        setFetchError(true);
      }
    };

    const scheduleNext = () => {
      let ms = 3000; // 기본 3초
      if (document.hidden) ms = 10000; // 비활성 탭
      else if (errCount > 0) ms = Math.min(10000 + errCount * 5000, 30000); // 에러 시 점진적 증가
      // 트리거/역전가 근접 시 1초 (hcCalc, pyraResult에서 ±3% 이내)
      // → state 직접 접근 불가하므로 DOM 대신 간단 체크
      clearTimeout(intervalRef.current);
      intervalRef.current = setTimeout(async () => {
        await fetchPrices();
        scheduleNext();
      }, ms);
    };

    fetchPrices().then(scheduleNext);

    // 탭 활성화 시 즉시 fetch
    const onVisibility = () => {
      if (!document.hidden) {
        fetchPrices().then(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      controller.abort();
      clearTimeout(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [usedCoins.join(","), priceMode]);

  // Sync split helper from dcaEntries when opening
  const openSplitHelper = () => {
    if (!splitMode) {
      // Pull prices and total from current dcaEntries
      const prices = dcaEntries.map((e) => e.price).filter((p) => n(p) > 0);
      const total = dcaEntries.reduce((a, e) => a + n(e.margin), 0);
      if (prices.length > 0) {
        setSplitPrices(prices.length > 0 ? prices : ["", "", ""]);
        if (total > 0) setSplitTotal(String(Math.round(total * 100) / 100));
      }
    }
    setSplitMode(!splitMode);
  };
  const addSplitPrice = () => setSplitPrices((p) => [...p, ""]);
  const rmSplitPrice = (idx) => setSplitPrices((p) => p.filter((_, i) => i !== idx));
  const updSplitPrice = (idx, v) => setSplitPrices((p) => p.map((x, i) => (i === idx ? v : x)));

  // CRUD
  const addPos = () => setPositions((p) => [...p, mkPos()]);
  const rmPos = (id) => {
    setPositions((p) => p.filter((x) => x.id !== id));
    if (selId === id) { setSelId(null); setDcaEntries([mkDCA()]); }
  };
  const updPos = useCallback((id, k, v) =>
    setPositions((ps) => ps.map((p) => (p.id === id ? { ...p, [k]: v } : p))), []);
  const selectPos = (id) => {
    setSelId((prev) => (prev === id ? null : id));
    setDcaEntries([mkDCA()]);
    setRevPrice(""); setRevTarget("");
    setDcaMode("sim");
    // Clear pyra when switching to DCA mode
    setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null);
  };

  // ── Pyramiding (불타기) selection ──
  // User clicks 🔥 on the WINNING position (the one they want to add to)
  // The opposite position (the losing one) gets locked
  const selectPyra = (pyraTargetId) => {
    // If already in pyra mode for this position, toggle off
    if (pyraMode && pyraCounterId === pyraTargetId) {
      setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null);
      return;
    }
    // Clear DCA selection
    setSelId(null);

    const target = positions.find((p) => p.id === pyraTargetId);
    if (!target) return;

    // pyraCounterId = the winning position (불타기 대상, the one user clicked)
    // pyraLockedId = the losing position (물린 포지션, opposite direction, auto-detected)
    setPyraMode(true);
    setPyraCounterId(pyraTargetId);
    setPyraSubMode("sim");
    setPyraEntries([mkPyra()]);
    setPyraRevPrice(""); setPyraRevTarget("");
    setPyraSplitMode(false);

    // Auto-detect the locked (losing) position — opposite direction, same coin
    const lockedDir = target.dir === "long" ? "short" : "long";
    const candidates = positions.filter((p) => p.id !== pyraTargetId && p.dir === lockedDir && p.coin === target.coin);
    if (candidates.length === 1) {
      setPyraLockedId(candidates[0].id);
    } else {
      setPyraLockedId(null); // user picks or none
    }
  };

  const addDCA = () => setDcaEntries((d) => [...d, mkDCA()]);
  const rmDCA = (id) => setDcaEntries((d) => d.filter((x) => x.id !== id));
  const updDCA = useCallback((id, k, v) =>
    setDcaEntries((ds) => ds.map((d) => (d.id === id ? { ...d, [k]: v } : d))), []);

  // Pyra CRUD
  const addPyra = () => setPyraEntries((d) => [...d, mkPyra()]);
  const rmPyra = (id) => setPyraEntries((d) => d.filter((x) => x.id !== id));
  const updPyra = useCallback((id, k, v) =>
    setPyraEntries((ds) => ds.map((d) => (d.id === id ? { ...d, [k]: v } : d))), []);

  const openPyraSplitHelper = () => {
    if (!pyraSplitMode) {
      const prices = pyraEntries.map((e) => e.price).filter((p) => n(p) > 0);
      const total = pyraEntries.reduce((a, e) => a + n(e.margin), 0);
      if (prices.length > 0) {
        setPyraSplitPrices(prices);
        if (total > 0) setPyraSplitTotal(String(Math.round(total * 100) / 100));
      }
    }
    setPyraSplitMode(!pyraSplitMode);
  };
  const addPyraSplitPrice = () => setPyraSplitPrices((p) => [...p, ""]);
  const rmPyraSplitPrice = (idx) => setPyraSplitPrices((p) => p.filter((_, i) => i !== idx));
  const updPyraSplitPrice = (idx, v) => setPyraSplitPrices((p) => p.map((x, i) => (i === idx ? v : x)));

  /* ═══════════════════════════════════════════
     CORE CALCULATIONS
     ═══════════════════════════════════════════ */
  const calc = useMemo(() => {
    const wb = n(wallet);
    const fee = n(feeRate) / 100;
    if (!wb) return null;

    // ── Parse positions (코인별 현재가 적용) ──
    // 마진 = 거래소에 표시된 값 그대로 (수수료 이미 차감됨)
    // 수수료 차감은 추가 진입(DCA/불타기) 시에만 적용
    const parsed = positions.map((p) => {
      const ep = n(p.entryPrice);
      const mg = n(p.margin);
      const lev = n(p.leverage);
      const notional = mg * lev;           // 진입 시 명목가 (고정)
      const qty = ep > 0 ? notional / ep : 0;
      const sign = p.dir === "long" ? 1 : -1;
      const pcp = n(coinPrices[p.coin] || ""); // 포지션별 현재가
      const liveNotional = pcp > 0 && qty > 0 ? qty * pcp : notional; // 실시간 포지션 크기
      let pnl = 0, roe = 0;
      if (pcp > 0 && qty > 0) {
        pnl = sign * (pcp - ep) * qty;
        roe = pct(pnl, mg);
      }
      return { ...p, ep, mg, lev, notional, liveNotional, qty, sign, pnl, roe, pcp };
    }).filter((p) => p.ep > 0 && p.mg > 0);

    // ── Account summary ──
    const totalPnL = parsed.reduce((a, p) => a + p.pnl, 0);
    const equity = wb + totalPnL;
    const totalMargin = parsed.reduce((a, p) => a + p.mg, 0);
    const lossOnlyPnL = parsed.reduce((a, p) => a + Math.min(p.pnl, 0), 0);
    const availEquity = wb + lossOnlyPnL;
    const freeMargin = availEquity - totalMargin;

    // 선택된 포지션 + 기준 현재가 (역산/청산가 계산용)
    const sel = selId ? parsed.find((p) => p.id === selId) || null : null;
    const cp = sel ? sel.pcp : (parsed.length > 0 ? parsed[0].pcp : 0);

    // ── 코인별 청산가에서 MMR 역산 ──
    // calcRefCoin의 청산가로 역산: 다른 코인 가격은 현재가 고정
    const calcRefCoin = sel ? sel.coin : (parsed[0]?.coin || "");
    const exLiq = getLiqPrice(calcRefCoin);
    let mmActual = null;
    let mmRate = null;
    let liqDistPct = null;

    if (exLiq > 0 && parsed.length > 0) {
      // equity at liq price: refCoin 포지션은 exLiq로 계산, 나머지는 현재가 고정
      mmActual = wb + parsed.reduce((a, p) => {
        const priceAtLiq = p.coin === calcRefCoin ? exLiq : p.pcp;
        return a + (priceAtLiq > 0 ? p.sign * (priceAtLiq - p.ep) * p.qty : 0);
      }, 0);

      // MMR = mmActual / totalNotionalAtLiqPrice
      const totalNotionalAtLiq = parsed.reduce((a, p) => {
        const priceAtLiq = p.coin === calcRefCoin ? exLiq : p.pcp;
        return a + p.qty * (priceAtLiq > 0 ? priceAtLiq : 0);
      }, 0);
      if (totalNotionalAtLiq > 0) {
        mmRate = mmActual / totalNotionalAtLiq;
      }

      if (cp > 0) {
        liqDistPct = ((cp - exLiq) / cp) * 100;
      }
    }

    // ── Helper: compute new liq price after position change ──
    // Given modified positions, solve for P where:
    //   wb + Σ sign_i × (P - ep_i) × qty_i = mmRate × Σ qty_i × P
    //
    // Expand:
    //   wb + P × Σ(sign_i × qty_i) - Σ(sign_i × ep_i × qty_i) = mmRate × P × Σ(qty_i)
    //   wb - Σ(sign_i × ep_i × qty_i) = P × [mmRate × Σ(qty_i) - Σ(sign_i × qty_i)]
    //   P = [wb - Σ(sign_i × ep_i × qty_i)] / [mmRate × Σ(qty_i) - Σ(sign_i × qty_i)]
    const solveLiq = (posArr, mmr) => {
      if (!mmr || mmr <= 0) return null;
      const sumSignQty = posArr.reduce((a, p) => a + p.sign * p.qty, 0);
      const sumSignEpQty = posArr.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
      const sumQty = posArr.reduce((a, p) => a + p.qty, 0);
      const denom = mmr * sumQty - sumSignQty;
      if (Math.abs(denom) < 1e-12) return null;
      const liq = (wb - sumSignEpQty) / denom;
      return liq > 0 ? liq : 0;
    };

    // ── 코인별 청산가 자동 계산 (MMR 역산 기반) ──
    // targetCoin의 가격만 움직이고, 나머지 코인은 현재가 고정 가정
    // equity(P) = wb + Σ pnl_i(P) = mmr × Σ notional_i(P)
    // targetCoin 포지션: pnl = sign*(P - ep)*qty, notional = qty*P
    // 다른 코인: pnl = sign*(pcp - ep)*qty (고정), notional = qty*pcp (고정)
    // => wb + Σ_target[sign*(P-ep)*qty] + Σ_other[pnl_fixed] = mmr × (Σ_target[qty*P] + Σ_other[notional_fixed])
    // => wb + P*Σ_t(sign*qty) - Σ_t(sign*ep*qty) + otherPnL = mmr*(P*Σ_t(qty) + otherNotional)
    // => P*(Σ_t(sign*qty) - mmr*Σ_t(qty)) = mmr*otherNotional - wb + Σ_t(sign*ep*qty) - otherPnL
    // => P = (mmr*otherNotional - wb + Σ_t(sign*ep*qty) - otherPnL) / (Σ_t(sign*qty) - mmr*Σ_t(qty))
    const solveLiqForCoin = (targetCoin, posArr, mmr) => {
      if (!mmr || mmr <= 0) return null;
      const targetPos = posArr.filter(p => p.coin === targetCoin);
      const otherPos = posArr.filter(p => p.coin !== targetCoin);
      if (targetPos.length === 0) return null;

      const sumTSignQty = targetPos.reduce((a, p) => a + p.sign * p.qty, 0);
      const sumTSignEpQty = targetPos.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
      const sumTQty = targetPos.reduce((a, p) => a + p.qty, 0);

      const otherPnL = otherPos.reduce((a, p) => {
        return a + (p.pcp > 0 ? p.sign * (p.pcp - p.ep) * p.qty : 0);
      }, 0);
      const otherNotional = otherPos.reduce((a, p) => {
        return a + p.qty * (p.pcp > 0 ? p.pcp : 0);
      }, 0);

      const numer = mmr * otherNotional - wb + sumTSignEpQty - otherPnL;
      const denom = sumTSignQty - mmr * sumTQty;
      if (Math.abs(denom) < 1e-12) return null;
      const liq = numer / denom;
      return liq > 0 ? liq : 0;
    };

    // 자동 계산된 코인별 청산가 맵
    const autoLiqPrices = {};
    if (mmRate && parsed.length > 0) {
      const allCoins = [...new Set(parsed.map(p => p.coin))];
      allCoins.forEach(coin => {
        // 이미 사용자가 직접 입력한 코인은 스킵 (기준 코인)
        if (coin === calcRefCoin) return;
        const coinPosCount = parsed.filter(p => p.coin === coin).length;
        if (coinPosCount === 0) return;
        // 해당 코인의 현재가가 있어야 계산 가능
        const coinCp = n(coinPrices[coin] || "");
        if (coinCp <= 0) return;
        const liq = solveLiqForCoin(coin, parsed, mmRate);
        if (liq != null && liq > 0) {
          autoLiqPrices[coin] = liq;
        }
      });
    }

    // ── Build DCA result (sim mode) ──
    let dcaResult = null;
    if (sel && dcaMode === "sim") {
      const dcaList = dcaEntries
        .filter((e) => n(e.price) > 0 && n(e.margin) > 0)
        .map((e) => {
          const price = n(e.price);
          const rawMargin = n(e.margin);
          // DCA 추가 마진: fromInput으로 정확한 수수료 차감
          const conv = fromInput(rawMargin, price, sel.lev, fee, sel.dir, sel.coin);
          if (!conv) return null;
          return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
        }).filter(Boolean);

      if (dcaList.length > 0) {
        const addTotalNotional = dcaList.reduce((a, d) => a + d.notional, 0);
        const addTotalQty = dcaList.reduce((a, d) => a + d.qty, 0);
        const addTotalMargin = dcaList.reduce((a, d) => a + d.margin, 0);

        const newNotional = sel.notional + addTotalNotional;
        const newQty = sel.qty + addTotalQty;
        const newAvg = newNotional / newQty;
        const newMargin = sel.mg + addTotalMargin;

        let afterPnL = 0, afterROE = 0;
        if (cp > 0) {
          afterPnL = sel.sign * (cp - newAvg) * newQty;
          afterROE = pct(afterPnL, newMargin);
        }

        // New liq price using exchange-derived MMR
        const afterParsed = parsed.map((p) =>
          p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
        );
        const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

        let afterLiqDist = null;
        if (afterLiq != null && cp > 0) {
          afterLiqDist = ((cp - afterLiq) / cp) * 100;
        }

        // Breakeven (대수적 해: 진입+청산 수수료 반영)
        const breakeven = sel.dir === "long"
          ? newAvg * (1 + fee) / (1 - fee)
          : newAvg * (1 - fee) / (1 + fee);
        const totalFee = Math.abs(breakeven - newAvg) * newQty;
        const moveNeeded = pct(breakeven - newAvg, newAvg);

        // Free margin after (Bybit: 손실만 반영)
        const afterTotalMargin = totalMargin + addTotalMargin;
        const afterLossPnL = parsed.reduce((a, p) => {
          const pnl = p.id === sel.id
            ? sel.sign * (cp > 0 ? (cp - newAvg) * newQty : 0)
            : p.pnl;
          return a + Math.min(pnl, 0);
        }, 0);
        const afterFreeMargin = (wb + afterLossPnL) - afterTotalMargin;

        const isLong = sel.dir === "long";
        const liqWorse = exLiq > 0 && afterLiq != null &&
          (isLong ? afterLiq > exLiq : afterLiq < exLiq);

        dcaResult = {
          dcaList, addTotalMargin,
          addTotalRawMargin: dcaList.reduce((a, d) => a + d.rawMargin, 0),
          addTotalFeeDeduct: dcaList.reduce((a, d) => a + d.feeDeduct, 0),
          before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
          after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
          breakeven, moveNeeded, totalFee, feeRate: fee,
          afterFreeMargin, liqWorse,
          avgDelta: newAvg - sel.ep,
          avgDeltaPct: pct(newAvg - sel.ep, sel.ep),
          marginInsufficient: dcaList.reduce((a, d) => a + d.rawMargin, 0) > Math.max(freeMargin, 0),
        };
      }
    }

    // ── Reverse calculation mode ──
    let revResult = null;
    if (sel && dcaMode === "reverse") {
      const rp = n(revPrice);
      const rt = n(revTarget);
      if (rp > 0 && rt > 0) {
        const isLong = sel.dir === "long";
        const denom = 1 - rt / rp;
        const impossible = (isLong ? rp > rt : rp < rt) || Math.abs(denom) < 1e-10;

        if (impossible) {
          revResult = { impossible: true };
        } else {
          const addNotional = (rt * sel.qty - sel.notional) / denom;
          if (addNotional <= 0) {
            revResult = { impossible: true };
          } else {
            const addMargin = addNotional / sel.lev;
            const addQty = addNotional / rp;
            const newQty = sel.qty + addQty;
            const newNotional = sel.notional + addNotional;
            const newMargin = sel.mg + addMargin;
            const newAvg = rt;

            let afterPnL = 0, afterROE = 0;
            if (cp > 0) {
              afterPnL = sel.sign * (cp - newAvg) * newQty;
              afterROE = pct(afterPnL, newMargin);
            }

            const afterParsed = parsed.map((p) =>
              p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
            );
            const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

            let afterLiqDist = null;
            if (afterLiq != null && cp > 0) {
              afterLiqDist = ((cp - afterLiq) / cp) * 100;
            }

            const breakeven = isLong
              ? newAvg * (1 + fee) / (1 - fee)
              : newAvg * (1 - fee) / (1 + fee);
            const totalFee = Math.abs(breakeven - newAvg) * newQty;
            const moveNeeded = pct(breakeven - newAvg, newAvg);

            const afterTotalMargin = totalMargin + addMargin;
            // Bybit 방식: 역산 후에도 손실만 반영
            const revAfterLossPnL = parsed.reduce((a, p) => {
              const pnl = p.id === sel.id
                ? sel.sign * (cp > 0 ? (cp - newAvg) * newQty : 0)
                : p.pnl;
              return a + Math.min(pnl, 0);
            }, 0);
            const afterFreeMargin = (wb + revAfterLossPnL) - afterTotalMargin;

            const liqWorse = exLiq > 0 && afterLiq != null &&
              (isLong ? afterLiq > exLiq : afterLiq < exLiq);

            let maxReachableAvg = null;
            if (addMargin > Math.max(freeMargin, 0) && freeMargin > 0) {
              const maxNotional = freeMargin * sel.lev;
              const maxQty = maxNotional / rp;
              maxReachableAvg = (sel.notional + maxNotional) / (sel.qty + maxQty);
            }

            // 수수료 포함 투입 필요 금액 역산
            const requiredInputMargin = fromDisplay(addMargin, rp, sel.lev, fee, sel.dir);
            const revFeeDeduct = requiredInputMargin - addMargin;

            revResult = {
              impossible: false,
              requiredMargin: addMargin,
              requiredInputMargin, revFeeDeduct,
              requiredNotional: addNotional, addQty,
              before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
              after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
              breakeven, moveNeeded, totalFee, feeRate: fee,
              afterFreeMargin, liqWorse,
              marginInsufficient: addMargin > Math.max(freeMargin, 0),
              maxReachableAvg,
            };
          }
        }
      }
    }

    // ── Solve price for target available amount (Bybit 방식: 이분법) ──
    // Bybit에서 available(P) = wb + Σ min(pnl_i(P), 0) - totalMargin
    // min() 클리핑으로 비선형이므로 이분법 탐색 사용

    // 주어진 가격 P에서 Bybit 방식 freeMargin 계산
    // refCoin: P가 적용되는 코인. 나머지 코인은 현재가(pcp) 고정.
    const calcFreeMarginAt = (P, posArr, extraMargin = 0) => {
      const arr = posArr || parsed;
      const tMg = arr.reduce((a, p) => a + p.mg, 0) + extraMargin;
      const lossPnL = arr.reduce((a, p) => {
        const priceForP = p.coin === calcRefCoin ? P : p.pcp;
        const pnl = priceForP > 0 ? p.sign * (priceForP - p.ep) * p.qty : 0;
        return a + Math.min(pnl, 0);
      }, 0);
      return wb + lossPnL - tMg;
    };

    const solvePriceForAvail = (target, posArr, extraMargin = 0) => {
      if (!cp || cp <= 0) return null;
      const cur = calcFreeMarginAt(cp, posArr, extraMargin);
      if (cur >= target) return cp; // 이미 충분

      // 양방향 포지션에서는 위/아래 어느 쪽으로 가도 available이 줄어들 수 있으므로
      // 양쪽 모두 탐색하여 해가 있는 방향을 찾음
      const bisect = (lo, hi) => {
        const fLo = calcFreeMarginAt(lo, posArr, extraMargin);
        const fHi = calcFreeMarginAt(hi, posArr, extraMargin);
        if (fLo < target && fHi < target) return null; // 범위 내 해 없음
        // fHi >= target 쪽으로 수렴
        let a = lo, b = hi;
        if (calcFreeMarginAt(a, posArr, extraMargin) >= target) {
          // a 쪽이 이미 충분 — a에서 target 미만이 되는 지점을 찾아야 함 (반전)
          [a, b] = [b, a];
        }
        // a: 부족, b: 충분
        for (let i = 0; i < 80; i++) {
          const mid = (a + b) / 2;
          if (calcFreeMarginAt(mid, posArr, extraMargin) < target) a = mid;
          else b = mid;
        }
        const result = (a + b) / 2;
        return result > 0 ? result : null;
      };

      const upResult = bisect(cp, cp * 200);
      const dnResult = bisect(0.001, cp);

      // 둘 다 해가 있으면 현재가에 더 가까운 쪽 반환
      if (upResult != null && dnResult != null) {
        return Math.abs(upResult - cp) < Math.abs(dnResult - cp) ? upResult : dnResult;
      }
      return upResult != null ? upResult : dnResult;
    };

    // Target available calc
    let availCalc = null;
    const tgt = n(targetAvail);
    if (tgt > 0 && parsed.length > 0 && cp > 0) {
      if (freeMargin >= tgt) {
        availCalc = { sufficient: true };
      } else {
        const neededPrice = solvePriceForAvail(tgt);
        if (neededPrice != null) {
          const direction = neededPrice > cp ? "up" : "down";
          const changePct = ((neededPrice - cp) / cp) * 100;
          availCalc = { sufficient: false, neededPrice, direction, changePct };
        } else {
          // 최대 확보 가능 금액 탐색 (샘플링)
          let maxAvail = freeMargin;
          let maxAvailPrice = cp;
          const samples = 200;
          for (let i = 0; i <= samples; i++) {
            // 위쪽 탐색
            const pUp = cp * (1 + (i / samples) * 10); // 0% ~ +1000%
            const fUp = calcFreeMarginAt(pUp);
            if (fUp > maxAvail) { maxAvail = fUp; maxAvailPrice = pUp; }
            // 아래쪽 탐색
            const pDn = cp * (1 - (i / samples) * 0.99); // 0% ~ -99%
            if (pDn > 0) {
              const fDn = calcFreeMarginAt(pDn);
              if (fDn > maxAvail) { maxAvail = fDn; maxAvailPrice = pDn; }
            }
          }
          const shortfall = tgt - maxAvail;
          availCalc = {
            sufficient: false, impossible: true,
            maxAvail, maxAvailPrice, shortfall,
            maxChangePct: ((maxAvailPrice - cp) / cp) * 100,
          };
        }
      }
    }

    // ── Shortfall price for DCA result ──
    const computeShortfallPrice = (addTotalMargin) => {
      if (freeMargin >= addTotalMargin) return null;
      const shortfall = addTotalMargin - Math.max(freeMargin, 0);
      // Need freeMargin to increase by shortfall
      // available(P) = wb + P*sumA - sumB - totalMargin = current freeMargin + delta
      // We need available(P) >= addTotalMargin
      const neededPrice = solvePriceForAvail(addTotalMargin);
      if (neededPrice != null && cp > 0) {
        return { price: neededPrice, shortfall, changePct: ((neededPrice - cp) / cp) * 100 };
      }
      return { shortfall, impossible: true };
    };

    // Attach shortfallPrice to dcaResult
    if (dcaResult && dcaResult.marginInsufficient) {
      dcaResult.shortfallInfo = computeShortfallPrice(dcaResult.addTotalMargin);
    }
    // Attach shortfallPrice to revResult
    if (revResult && !revResult.impossible && revResult.marginInsufficient) {
      revResult.shortfallInfo = computeShortfallPrice(revResult.requiredMargin);
    }

    // ── Close (손절) simulation ──
    let closeResult = null;
    if (sel && dcaMode === "close") {
      const ratio = n(closeRatio) / 100;
      const cp2 = n(closePrice) || cp; // default to current price
      if (ratio > 0 && ratio <= 1 && cp2 > 0) {
        const closedQty = sel.qty * ratio;
        const closedNotional = sel.notional * ratio;
        const closedMargin = sel.mg * ratio;

        // Realized PnL from closing
        const realizedPnL = sel.sign * (cp2 - sel.ep) * closedQty;
        // Close fee (one-way since opening fee already paid)
        const closeFee = closedQty * cp2 * fee;

        // Remaining position
        const remQty = sel.qty - closedQty;
        const remNotional = sel.notional - closedNotional;
        const remMargin = sel.mg - closedMargin;

        // New wallet balance: old wallet + realizedPnL - closeFee
        // In cross margin, realized PnL is added to wallet, margin is released
        const newWallet = wb + realizedPnL - closeFee;

        // Remaining unrealized PnL (all positions, with sel reduced)
        const remParsed = parsed.map((p) =>
          p.id === sel.id
            ? { ...p, qty: remQty, notional: remNotional, mg: remMargin }
            : p
        ).filter((p) => p.qty > 0);

        const remTotalPnL = remParsed.reduce((a, p) => a + p.sign * (cp - p.ep) * p.qty, 0);
        const remEquity = newWallet + remTotalPnL;
        const remTotalMargin = remParsed.reduce((a, p) => a + p.mg, 0);
        // Bybit 방식: 손실만 반영
        const remLossPnL = remParsed.reduce((a, p) => {
          const pnl = p.sign * (cp - p.ep) * p.qty;
          return a + Math.min(pnl, 0);
        }, 0);
        const remFreeMargin = (newWallet + remLossPnL) - remTotalMargin;

        // New liq price
        const remLiq = mmRate ? solveLiq(remParsed, mmRate) : null;
        let remLiqDist = null;
        if (remLiq != null && cp > 0) {
          remLiqDist = ((cp - remLiq) / cp) * 100;
        }

        // Remaining position PnL
        let remPosPnL = 0, remPosROE = 0;
        if (remQty > 0 && cp > 0) {
          remPosPnL = sel.sign * (cp - sel.ep) * remQty;
          remPosROE = remMargin > 0 ? pct(remPosPnL, remMargin) : 0;
        }

        // "손절 후 물타기" scenario: use all freed margin at a hypothetical DCA price
        // We'll compute for the DCA price entered in sim mode (first entry), or skip
        let closeAndDCA = null;
        if (remFreeMargin > 0 && remQty > 0) {
          // Use the first DCA entry price if available, otherwise skip
          const dcaPrice = dcaEntries.length > 0 ? n(dcaEntries[0].price) : 0;
          if (dcaPrice > 0) {
            const dcaRawMargin = remFreeMargin;
            const dcaConv = fromInput(dcaRawMargin, dcaPrice, sel.lev, fee, sel.dir, sel.coin);
            const dcaMargin = dcaConv ? dcaConv.margin : 0;
            const dcaNotional = dcaConv ? dcaConv.size : 0;
            const dcaQty = dcaConv ? dcaConv.qty : 0;
            const newQty2 = remQty + dcaQty;
            const newNotional2 = remNotional + dcaNotional;
            const newAvg2 = newNotional2 / newQty2;
            const newMargin2 = remMargin + dcaMargin;

            const afterPnL2 = sel.sign * (cp - newAvg2) * newQty2;
            const afterROE2 = newMargin2 > 0 ? pct(afterPnL2, newMargin2) : 0;

            const breakeven2 = sel.dir === "long"
              ? newAvg2 * (1 + fee) / (1 - fee)
              : newAvg2 * (1 - fee) / (1 + fee);

            // New liq after close + DCA
            const cdParsed = remParsed.map((p) =>
              p.id === sel.id
                ? { ...p, ep: newAvg2, qty: newQty2, notional: newNotional2, mg: newMargin2 }
                : p
            );
            const cdLiq = mmRate ? solveLiq(cdParsed, mmRate) : null;

            closeAndDCA = {
              dcaPrice, dcaMargin, dcaQty,
              newAvg: newAvg2, newQty: newQty2, newMargin: newMargin2,
              pnl: afterPnL2, roe: afterROE2,
              breakeven: breakeven2,
              liq: cdLiq,
            };
          }
        }

        closeResult = {
          ratio, closePrice: cp2, closedQty, closedMargin,
          realizedPnL, closeFee,
          newWallet,
          remaining: {
            qty: remQty, notional: remNotional, margin: remMargin,
            avg: sel.ep, // avg doesn't change on partial close
            pnl: remPosPnL, roe: remPosROE,
          },
          remEquity, remTotalMargin, remFreeMargin,
          remLiq, remLiqDist,
          liqBefore: exLiq || null,
          liqDistBefore: liqDistPct,
          closeAndDCA,
        };
      }
    }

    // ── Split optimization ──
    let splitResult = null;
    if (sel && dcaMode === "sim" && splitMode) {
      const sTotal = n(splitTotal);
      const prices = splitPrices.map((p) => n(p)).filter((p) => p > 0);
      const sCount = prices.length;

      if (sTotal > 0 && sCount >= 2) {
        const isLong = sel.dir === "long";

        // Sort prices: for long, high→low (closer to current first); for short, low→high
        const sorted = [...prices].sort((a, b) => isLong ? b - a : a - b);

        const strategies = [
          {
            name: "균등",
            desc: "동일 금액",
            weights: sorted.map(() => 1),
          },
          {
            name: "앞에 몰기",
            desc: "현재가 근처에 많이",
            weights: sorted.map((_, i) => sCount - i),
          },
          {
            name: "뒤에 몰기",
            desc: "유리한 가격에 많이",
            weights: sorted.map((_, i) => i + 1),
          },
          {
            name: "마틴게일",
            desc: "2배씩 증가",
            weights: sorted.map((_, i) => Math.pow(2, i)),
          },
        ];

        const results = strategies.map((strat) => {
          const totalWeight = strat.weights.reduce((a, w) => a + w, 0);
          const entries = sorted.map((price, i) => {
            const rawMargin = sTotal * strat.weights[i] / totalWeight;
            const conv = fromInput(rawMargin, price, sel.lev, fee, sel.dir, sel.coin);
            if (!conv) return { price, rawMargin, margin: 0, feeDeduct: 0, notional: 0, qty: 0 };
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          });

          const addNotional = entries.reduce((a, e) => a + e.notional, 0);
          const addQty = entries.reduce((a, e) => a + e.qty, 0);
          const newNotional = sel.notional + addNotional;
          const newQty = sel.qty + addQty;
          const newAvg = newNotional / newQty;
          const newMargin = sel.mg + entries.reduce((a, e) => a + e.margin, 0);

          const afterParsed = parsed.map((p) =>
            p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
          );
          const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

          const breakeven = isLong
            ? newAvg * (1 + fee) / (1 - fee)
            : newAvg * (1 - fee) / (1 + fee);

          let afterPnL = 0, afterROE = 0;
          if (cp > 0) {
            afterPnL = sel.sign * (cp - newAvg) * newQty;
            afterROE = pct(afterPnL, newMargin);
          }

          return {
            name: strat.name, desc: strat.desc, entries,
            newAvg, newQty, newMargin, newNotional,
            afterLiq, breakeven, afterPnL, afterROE,
          };
        });

        let bestIdx = 0;
        results.forEach((r, i) => {
          if (isLong ? r.newAvg < results[bestIdx].newAvg : r.newAvg > results[bestIdx].newAvg) {
            bestIdx = i;
          }
        });

        splitResult = {
          prices: sorted, results, bestIdx,
          totalMargin: sTotal,
          marginInsufficient: sTotal > Math.max(freeMargin, 0),
        };
      }
    }

    // ── Pyramiding (불타기) calculation ──
    let pyraResult = null;
    let pyraRevResult = null;
    const pyraLocked = pyraMode ? parsed.find((p) => p.id === pyraLockedId) : null;
    const pyraCounter = pyraMode && pyraCounterId ? parsed.find((p) => p.id === pyraCounterId) : null;

    if (pyraCounter && pyraMode) {
      // counter = winning position (불타기 대상), locked = losing position (물린)
      // pyraEntries add to the counter position's direction
      const counterDir = pyraCounter.dir;
      const counterSign = pyraCounter.sign;
      const lockedSign = pyraLocked ? pyraLocked.sign : 0;
      const lockedEp = pyraLocked ? pyraLocked.ep : 0;
      const lockedQty = pyraLocked ? pyraLocked.qty : 0;
      const lockedMg = pyraLocked ? pyraLocked.mg : 0;
      const lockedDir = pyraLocked ? pyraLocked.dir : (counterDir === "long" ? "short" : "long");
      const hasLocked = pyraLocked != null;

      if (pyraSubMode === "sim") {
        // Parse pyramiding entries as new counter-direction entries
        const pyraList = pyraEntries
          .filter((e) => n(e.price) > 0 && n(e.margin) > 0)
          .map((e) => {
            const price = n(e.price);
            const rawMargin = n(e.margin);
            const conv = fromInput(rawMargin, price, pyraCounter.lev, fee, pyraCounter.dir, pyraCounter.coin);
            if (!conv) return null;
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          }).filter(Boolean);

        if (pyraList.length > 0 || pyraCounter) {
          // Existing counter position values
          const existCounterNotional = pyraCounter ? pyraCounter.notional : 0;
          const existCounterQty = pyraCounter ? pyraCounter.qty : 0;
          const existCounterMargin = pyraCounter ? pyraCounter.mg : 0;
          const existCounterEp = pyraCounter ? pyraCounter.ep : 0;

          // New entries from pyramiding
          const addTotalNotional = pyraList.reduce((a, d) => a + d.notional, 0);
          const addTotalQty = pyraList.reduce((a, d) => a + d.qty, 0);
          const addTotalMargin = pyraList.reduce((a, d) => a + d.margin, 0);

          // Combined counter position
          const totalCounterNotional = existCounterNotional + addTotalNotional;
          const totalCounterQty = existCounterQty + addTotalQty;
          const totalCounterMargin = existCounterMargin + addTotalMargin;
          const totalCounterAvg = totalCounterQty > 0 ? totalCounterNotional / totalCounterQty : 0;

          // Locked position PnL at various prices
          const lockedPnLAt = (p) => lockedSign * (p - lockedEp) * lockedQty;
          const counterPnLAt = (p) => totalCounterQty > 0 ? counterSign * (p - totalCounterAvg) * totalCounterQty : 0;

          // Close fees for simultaneous close at price P
          const closeFeeAt = (p) => {
            const lockedFee = lockedQty * p * fee;
            const counterFee = totalCounterQty * p * fee;
            return lockedFee + counterFee;
          };

          // Combined net PnL at price P
          const netPnLAt = (p) => lockedPnLAt(p) + counterPnLAt(p) - closeFeeAt(p);

          // Solve reversal price: lockedPnL + counterPnL - fees = 0
          // sign_a*(P-ep_a)*qty_a + sign_b*(P-ep_b)*qty_b - fee*(qty_a+qty_b)*P = 0
          // P * [sign_a*qty_a + sign_b*qty_b - fee*(qty_a+qty_b)] = sign_a*ep_a*qty_a + sign_b*ep_b*qty_b
          let reversalPrice = null;
          if (totalCounterQty > 0) {
            const coefP = lockedSign * lockedQty + counterSign * totalCounterQty - fee * (lockedQty + totalCounterQty);
            const constTerm = lockedSign * lockedEp * lockedQty + counterSign * totalCounterAvg * totalCounterQty;
            if (Math.abs(coefP) > 1e-12) {
              const rp = constTerm / coefP;
              if (rp > 0) reversalPrice = rp;
            }
          }

          // Distance from current price to reversal
          let reversalDist = null;
          if (reversalPrice != null && cp > 0) {
            reversalDist = ((reversalPrice - cp) / cp) * 100;
          }

          // Combined PnL at current price
          const combinedPnL = cp > 0 ? lockedPnLAt(cp) + counterPnLAt(cp) : 0;
          const simultaneousClose = cp > 0 ? netPnLAt(cp) : 0;

          // New liq price after adding counter entries
          let newLiqPrice = null;
          let newLiqDist = null;
          if (mmRate && pyraList.length > 0) {
            const afterParsed = [...parsed];
            if (pyraCounter) {
              // Update existing counter position
              const idx = afterParsed.findIndex((p) => p.id === pyraCounterId);
              if (idx >= 0) {
                afterParsed[idx] = {
                  ...afterParsed[idx],
                  ep: totalCounterAvg, mg: totalCounterMargin,
                  notional: totalCounterNotional, qty: totalCounterQty,
                };
              }
            } else {
              // Add new virtual counter position
              afterParsed.push({
                id: "pyra-virtual", dir: counterDir, sign: counterSign,
                ep: totalCounterAvg, mg: totalCounterMargin,
                notional: totalCounterNotional, qty: totalCounterQty,
                lev: pyraCounter.lev,
              });
            }
            newLiqPrice = solveLiq(afterParsed, mmRate);
            if (newLiqPrice != null && cp > 0) {
              newLiqDist = ((cp - newLiqPrice) / cp) * 100;
            }
          }

          // Stage-by-stage analysis
          const stages = [];
          let cumNotional = existCounterNotional;
          let cumQty = existCounterQty;
          let cumMargin = existCounterMargin;

          // If existing counter, add as stage 0
          if (pyraCounter) {
            stages.push({
              step: 0, label: "기존 포지션",
              margin: existCounterMargin, cumMargin: existCounterMargin,
              avg: existCounterEp,
              reversalPrice: (() => {
                const coef = lockedSign * lockedQty + counterSign * existCounterQty - fee * (lockedQty + existCounterQty);
                const ct = lockedSign * lockedEp * lockedQty + counterSign * existCounterEp * existCounterQty;
                if (Math.abs(coef) > 1e-12) { const r = ct / coef; return r > 0 ? r : null; }
                return null;
              })(),
              liqPrice: exLiq || null,
              liqDist: liqDistPct,
            });
          }

          pyraList.forEach((entry, i) => {
            cumNotional += entry.notional;
            cumQty += entry.qty;
            cumMargin += entry.margin;
            const stepAvg = cumNotional / cumQty;

            // Reversal price at this stage
            const coef = lockedSign * lockedQty + counterSign * cumQty - fee * (lockedQty + cumQty);
            const ct = lockedSign * lockedEp * lockedQty + counterSign * stepAvg * cumQty;
            let stepReversal = null;
            if (Math.abs(coef) > 1e-12) { const r = ct / coef; if (r > 0) stepReversal = r; }

            // Liq price at this stage
            let stepLiq = null, stepLiqDist = null;
            if (mmRate) {
              const stepParsed = [...parsed];
              if (pyraCounter) {
                const idx = stepParsed.findIndex((p) => p.id === pyraCounterId);
                if (idx >= 0) {
                  stepParsed[idx] = { ...stepParsed[idx], ep: stepAvg, mg: cumMargin, notional: cumNotional, qty: cumQty };
                }
              } else {
                // For stages, add virtual
                stepParsed.push({
                  id: "pyra-virtual", dir: counterDir, sign: counterSign,
                  ep: stepAvg, mg: cumMargin, notional: cumNotional, qty: cumQty, lev: pyraCounter.lev,
                });
              }
              stepLiq = solveLiq(stepParsed, mmRate);
              if (stepLiq != null && cp > 0) stepLiqDist = ((cp - stepLiq) / cp) * 100;
            }

            stages.push({
              step: i + 1,
              label: pyraCounter && i === 0 ? "불타기 1" : `불타기 ${pyraCounter ? i + 1 : i + 1}`,
              margin: entry.margin, cumMargin,
              avg: stepAvg,
              reversalPrice: stepReversal,
              liqPrice: stepLiq, liqDist: stepLiqDist,
            });
          });

          // Scenarios table: at various prices
          const scenarios = [];
          if (cp > 0 && totalCounterQty > 0) {
            const pricePoints = [];
            // Add reversal price
            if (reversalPrice) pricePoints.push({ label: "역전가", price: reversalPrice });
            // Add current price
            pricePoints.push({ label: "현재가", price: cp });
            // Add percentage offsets from current
            const offsets = pyraCounter.dir === "short"
              ? [-1, -3, -5, -10] // price drops (short gaining, locked long losing)
              : [1, 3, 5, 10];    // price rises (long gaining, locked short losing)
            offsets.forEach((pctOff) => {
              pricePoints.push({ label: `${pctOff > 0 ? "+" : ""}${pctOff}%`, price: cp * (1 + pctOff / 100) });
            });
            // Sort by price
            pricePoints.sort((a, b) => a.price - b.price);

            pricePoints.forEach(({ label, price }) => {
              scenarios.push({
                label, price,
                lockedPnL: lockedPnLAt(price),
                counterPnL: counterPnLAt(price),
                combined: lockedPnLAt(price) + counterPnLAt(price),
                fee: closeFeeAt(price),
                net: netPnLAt(price),
              });
            });
          }

          // Warnings
          const warnings = [];
          if (newLiqDist != null && Math.abs(newLiqDist) < 15) {
            warnings.push({ type: "danger", message: `청산 위험 — 여유 ${fmt(Math.abs(newLiqDist))}% (15% 미만)` });
          }
          if (addTotalMargin > Math.max(freeMargin, 0)) {
            warnings.push({ type: "danger", message: `사용 가능(${fmt(freeMargin)}) < 필요 마진(${fmt(addTotalMargin)}) USDT` });
          }

          // Info items
          const infos = [];
          const lockedMargin = lockedMg;
          if (totalCounterMargin > lockedMargin) {
            infos.push(`반대 포지션 누적(${fmt(totalCounterMargin)})이 물린 포지션(${fmt(lockedMargin)})보다 큽니다`);
          }
          if (totalCounterMargin > lockedMargin * 2) {
            infos.push(`반대 포지션이 물린 포지션의 ${fmt(totalCounterMargin / lockedMargin, 1)}배입니다`);
          }

          // 청산 시나리오 3가지
          const closeScenarios = cp > 0 ? {
            both: {
              pnl: lockedPnLAt(cp) + counterPnLAt(cp),
              fee: closeFeeAt(cp),
              net: netPnLAt(cp),
              label: "양쪽 동시 청산",
            },
            lockedOnly: {
              pnl: lockedPnLAt(cp),
              fee: lockedQty * cp * fee,
              net: lockedPnLAt(cp) - lockedQty * cp * fee,
              label: "물린 쪽만 청산",
            },
            counterOnly: {
              pnl: counterPnLAt(cp),
              fee: totalCounterQty * cp * fee,
              net: counterPnLAt(cp) - totalCounterQty * cp * fee,
              label: "불타기 쪽만 청산",
            },
          } : null;

          // 역전가 프로그레스
          let reversalProgress = null;
          if (reversalPrice && cp > 0 && hasLocked) {
            // 물린 포지션 진입가 → 역전가 구간에서 현재가의 위치
            const start = lockedEp;
            const end = reversalPrice;
            const range = Math.abs(end - start);
            if (range > 0) {
              const dist = Math.abs(cp - start);
              reversalProgress = Math.min(Math.max(dist / range, 0), 1);
              // 방향 보정: 역전가 쪽으로 가고 있는지 확인
              if (counterSign > 0) {
                // counter가 롱이면 가격이 올라야 역전 → cp > start일 때 진행 중
                reversalProgress = cp > start ? Math.min((cp - start) / (end - start), 1) : 0;
              } else {
                // counter가 숏이면 가격이 내려야 역전 → cp < start일 때 진행 중
                reversalProgress = cp < start ? Math.min((start - cp) / (start - end), 1) : 0;
              }
              reversalProgress = Math.max(Math.min(reversalProgress, 1), 0);
            }
          }

          // 불타기 vs 물타기 비교 (같은 금액을 물린 포지션에 DCA할 때)
          let dcaComparison = null;
          if (addTotalMargin > 0 && hasLocked && cp > 0) {
            // 물타기: 물린 포지션의 대표 가격(첫 번째 pyraEntry 가격)으로 DCA
            const dcaPrice = pyraList.length > 0 ? pyraList[0].price : cp;
            const dcaNotional = addTotalMargin * (pyraLocked?.lev || pyraCounter.lev);
            const dcaQty = dcaPrice > 0 ? dcaNotional / dcaPrice : 0;
            const dcaNewNotional = (pyraLocked ? pyraLocked.notional : 0) + dcaNotional;
            const dcaNewQty = lockedQty + dcaQty;
            const dcaNewAvg = dcaNewQty > 0 ? dcaNewNotional / dcaNewQty : 0;
            const dcaNewMargin = lockedMg + addTotalMargin;

            // DCA 후 본전가 (수수료 포함)
            const dcaBreakeven = lockedSign > 0
              ? dcaNewAvg * (1 + fee) / (1 - fee)
              : dcaNewAvg * (1 - fee) / (1 + fee);

            // DCA 후 청산가
            let dcaLiq = null;
            if (mmRate) {
              const dcaParsed = [...parsed];
              const idx = dcaParsed.findIndex((p) => p.id === pyraLockedId);
              if (idx >= 0) {
                dcaParsed[idx] = { ...dcaParsed[idx], ep: dcaNewAvg, mg: dcaNewMargin, notional: dcaNewNotional, qty: dcaNewQty };
              }
              dcaLiq = solveLiq(dcaParsed, mmRate);
            }

            dcaComparison = {
              dcaAvg: dcaNewAvg, dcaBreakeven, dcaLiq, dcaMargin: dcaNewMargin,
              pyraReversal: reversalPrice, pyraLiq: newLiqPrice,
              dcaPrice,
            };
          }

          pyraResult = {
            locked: pyraLocked, counterDir, counterSign,
            existingCounter: pyraCounter,
            pyraList, addTotalMargin,
            counter: {
              avg: totalCounterAvg, qty: totalCounterQty,
              margin: totalCounterMargin, notional: totalCounterNotional,
            },
            reversalPrice, reversalDist, reversalProgress,
            combinedPnL, simultaneousClose,
            closeScenarios,
            newLiqPrice, newLiqDist,
            liqBefore: exLiq || null, liqDistBefore: liqDistPct,
            stages, scenarios, warnings, infos,
            marginInsufficient: addTotalMargin > Math.max(freeMargin, 0),
            dcaComparison,
          };
        }
      }

      // ── Pyramiding reverse calc: target reversal price → needed margin ──
      if (pyraSubMode === "reverse") {
        const prp = n(pyraRevPrice);
        const prt = n(pyraRevTarget);

        if (prp > 0 && prt > 0 && hasLocked) {
          const rCounterSign = pyraCounter.sign;
          const existCounterQty = pyraCounter.qty;
          const existCounterNotional = pyraCounter.notional;
          const existCounterMargin = pyraCounter.mg;
          const existCounterAvg = pyraCounter.ep;

          // Solve: at target reversal price T, net PnL = 0
          // locked_pnl(T) + counter_pnl(T) - fees(T) = 0
          // sign_a*(T-ep_a)*qty_a + sign_b*(T - newAvg)*(existQty + addQty) - fee*(qty_a + existQty + addQty)*T = 0
          // where addQty = addNotional/prp, addNotional = addMargin * lev, newAvg = (existNotional + addNotional)/(existQty + addQty)
          //
          // This is complex, so we solve numerically (binary search for addMargin)
          const lockedPnlAtT = lockedSign * (prt - lockedEp) * lockedQty;

          // Function: given addMargin, what is net PnL at target price?
          const netAtTarget = (addMargin) => {
            const addNotional = addMargin * pyraCounter.lev;
            const addQty = addNotional / prp;
            const tNotional = existCounterNotional + addNotional;
            const tQty = existCounterQty + addQty;
            const tAvg = tQty > 0 ? tNotional / tQty : 0;
            const counterPnl = counterSign * (prt - tAvg) * tQty;
            const closeFees = (lockedQty + tQty) * prt * fee;
            return lockedPnlAtT + counterPnl - closeFees;
          };

          // Check if already reversed without adding anything
          const netZero = netAtTarget(0);

          if (netZero >= 0) {
            pyraRevResult = { alreadyReversed: true };
          } else {
            // Binary search for addMargin that makes netAtTarget = 0
            let lo = 0, hi = 100000, found = false, resultMargin = 0;
            for (let iter = 0; iter < 100; iter++) {
              const mid = (lo + hi) / 2;
              const val = netAtTarget(mid);
              if (Math.abs(val) < 0.01) { resultMargin = mid; found = true; break; }
              if (val < 0) lo = mid; else hi = mid;
            }
            if (!found) resultMargin = (lo + hi) / 2;

            if (resultMargin > 0) {
              const addNotional = resultMargin * pyraCounter.lev;
              const addQty = addNotional / prp;
              const tNotional = existCounterNotional + addNotional;
              const tQty = existCounterQty + addQty;
              const tAvg = tNotional / tQty;
              const tMargin = existCounterMargin + resultMargin;

              // Compute new liq
              let revLiq = null, revLiqDist = null;
              if (mmRate) {
                const revParsed = [...parsed];
                if (pyraCounter) {
                  const idx = revParsed.findIndex((p) => p.id === pyraCounterId);
                  if (idx >= 0) {
                    revParsed[idx] = { ...revParsed[idx], ep: tAvg, mg: tMargin, notional: tNotional, qty: tQty };
                  }
                } else {
                  revParsed.push({
                    id: "pyra-virtual", dir: counterDir, sign: counterSign,
                    ep: tAvg, mg: tMargin, notional: tNotional, qty: tQty, lev: pyraCounter.lev,
                  });
                }
                revLiq = solveLiq(revParsed, mmRate);
                if (revLiq != null && cp > 0) revLiqDist = ((cp - revLiq) / cp) * 100;
              }

              pyraRevResult = {
                alreadyReversed: false,
                neededMargin: resultMargin,
                counterAvg: tAvg,
                counterMargin: tMargin,
                liqPrice: revLiq,
                liqDist: revLiqDist,
                feasible: resultMargin <= Math.max(freeMargin, 0),
                marginInsufficient: resultMargin > Math.max(freeMargin, 0),
              };
            } else {
              pyraRevResult = { impossible: true };
            }
          }
        }
      }
    }

    // ── Pyramiding split optimization ──
    let pyraSplitResult = null;
    if (pyraCounter && pyraMode && pyraSubMode === "sim" && pyraSplitMode) {
      const sTotal = n(pyraSplitTotal);
      const prices = pyraSplitPrices.map((p) => n(p)).filter((p) => p > 0);
      const sCount = prices.length;

      if (sTotal > 0 && sCount >= 2) {
        const isCounterLong = pyraCounter.dir === "long";
        // For pyramiding: sort by distance from current price
        const sorted = [...prices].sort((a, b) => isCounterLong ? b - a : a - b);

        const strategies = [
          { name: "균등", desc: "동일 금액", weights: sorted.map(() => 1) },
          { name: "초기 집중", desc: "빠른 역전 추구", weights: sorted.map((_, i) => sCount - i) },
          { name: "확인 후 증액", desc: "추세 확인 후", weights: sorted.map((_, i) => i + 1) },
          { name: "마틴게일", desc: "⚠ 고위험", weights: sorted.map((_, i) => Math.pow(2, i)) },
        ];

        const results = strategies.map((strat) => {
          const totalWeight = strat.weights.reduce((a, w) => a + w, 0);
          const entries = sorted.map((price, i) => {
            const rawMargin = sTotal * strat.weights[i] / totalWeight;
            const conv = fromInput(rawMargin, price, pyraCounter.lev, fee, pyraCounter.dir, pyraCounter.coin);
            if (!conv) return { price, rawMargin, margin: 0, feeDeduct: 0, notional: 0, qty: 0 };
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          });
          return { name: strat.name, desc: strat.desc, entries };
        });

        pyraSplitResult = {
          prices: sorted, results,
          totalMargin: sTotal,
          marginInsufficient: sTotal > Math.max(freeMargin, 0),
        };
      }
    }

    // ── 동시청산 계산기 ──
    const hedgePairs = [];
    const pairCoins = [...new Set(parsed.map(p => p.coin))];
    pairCoins.forEach(coin => {
      const longPos = parsed.find(p => p.coin === coin && p.dir === "long");
      const shortPos = parsed.find(p => p.coin === coin && p.dir === "short");
      if (!longPos || !shortPos) return;

      const coinCp = n(coinPrices[coin] || "");
      if (coinCp <= 0) return;

      const lr = Math.min(Math.max(n(scCloseRatios[coin]?.long || "100") / 100, 0), 1);
      const sr = Math.min(Math.max(n(scCloseRatios[coin]?.short || "100") / 100, 0), 1);
      const target = n(scTargets[coin] || "");

      const closeLq = longPos.qty * lr;
      const closeSq = shortPos.qty * sr;
      if (closeLq <= 0 && closeSq <= 0) return;

      // 진입 수수료 (이미 지불됨) = 청산되는 수량의 진입 노셔널 × fee
      const entryFees = (closeLq * longPos.ep + closeSq * shortPos.ep) * fee;

      // P에 대한 1차방정식 분모
      const denom = closeLq - closeSq - (closeLq + closeSq) * fee;

      // 가격별 계산 함수
      const longPnLAt = (P) => (P - longPos.ep) * closeLq;
      const shortPnLAt = (P) => (shortPos.ep - P) * closeSq;
      const closeFeeAt = (P) => (closeLq + closeSq) * P * fee;
      const netCloseAt = (P) => longPnLAt(P) + shortPnLAt(P) - closeFeeAt(P);
      const netAllAt = (P) => netCloseAt(P) - entryFees;

      // 본전가 / 목표가 역산
      const constTerm = longPos.ep * closeLq - shortPos.ep * closeSq;
      let breakevenClose = null, breakevenAll = null, targetPrice = null;

      if (Math.abs(denom) > 1e-12) {
        const beC = constTerm / denom;
        if (beC > 0) breakevenClose = beC;

        const beA = (constTerm + entryFees) / denom;
        if (beA > 0) breakevenAll = beA;

        if (target > 0) {
          const tp = (constTerm + entryFees + target) / denom;
          if (tp > 0) targetPrice = tp;
        }
      }

      // 시나리오 테이블
      const scenarios = [];
      [-10, -5, -3, -1, 0, 1, 3, 5, 10].forEach(pv => {
        const P = coinCp * (1 + pv / 100);
        scenarios.push({
          label: pv === 0 ? "현재가" : `${pv > 0 ? "+" : ""}${pv}%`,
          price: P, longPnL: longPnLAt(P), shortPnL: shortPnLAt(P),
          closeFee: closeFeeAt(P), netClose: netCloseAt(P), netAll: netAllAt(P),
          isCurrent: pv === 0,
        });
      });
      if (breakevenAll) scenarios.push({ label: "본전(전체)", price: breakevenAll, longPnL: longPnLAt(breakevenAll), shortPnL: shortPnLAt(breakevenAll), closeFee: closeFeeAt(breakevenAll), netClose: netCloseAt(breakevenAll), netAll: 0, isSpecial: true });
      if (breakevenClose) scenarios.push({ label: "본전(청산)", price: breakevenClose, longPnL: longPnLAt(breakevenClose), shortPnL: shortPnLAt(breakevenClose), closeFee: closeFeeAt(breakevenClose), netClose: 0, netAll: netAllAt(breakevenClose), isSpecial: true });
      if (targetPrice) scenarios.push({ label: "목표", price: targetPrice, longPnL: longPnLAt(targetPrice), shortPnL: shortPnLAt(targetPrice), closeFee: closeFeeAt(targetPrice), netClose: netCloseAt(targetPrice), netAll: target, isSpecial: true });
      scenarios.sort((a, b) => a.price - b.price);

      hedgePairs.push({
        coin, coinCp, long: longPos, short: shortPos,
        lr, sr, closeLq, closeSq, entryFees,
        breakevenAll, breakevenClose, targetPrice,
        beAllDist: breakevenAll ? ((breakevenAll - coinCp) / coinCp) * 100 : null,
        beCloseDist: breakevenClose ? ((breakevenClose - coinCp) / coinCp) * 100 : null,
        targetDist: targetPrice ? ((targetPrice - coinCp) / coinCp) * 100 : null,
        currentLongPnL: longPnLAt(coinCp), currentShortPnL: shortPnLAt(coinCp),
        currentCloseFee: closeFeeAt(coinCp),
        currentNetClose: netCloseAt(coinCp), currentNetAll: netAllAt(coinCp),
        scenarios, target,
      });
    });

    return {
      parsed, wb, cp, fee, exLiq, calcRefCoin, autoLiqPrices, solveLiqForCoin,
      totalPnL, equity, totalMargin, freeMargin,
      mmActual, mmRate, liqDistPct,
      sel, dcaResult, revResult, closeResult, splitResult, availCalc,
      pyraResult, pyraRevResult, pyraSplitResult,
      pyraLocked, pyraCounter,
      hedgePairs,
    };
  }, [wallet, coinPrices, feeRate, coinLiqPrices, positions, selId, dcaMode, dcaEntries, revPrice, revTarget, targetAvail, closeRatio, closePrice, splitMode, splitTotal, splitPrices, pyraMode, pyraLockedId, pyraCounterId, pyraSubMode, pyraEntries, pyraRevPrice, pyraRevTarget, pyraSplitMode, pyraSplitTotal, pyraSplitPrices, scCloseRatios, scTargets]);

  const selPos = positions.find((p) => p.id === selId);

  /* ═══════════════════════════════════════════
     HEDGE CYCLE CALC
     ═══════════════════════════════════════════ */
  const hcCalc = useMemo(() => {
    const cp = getCp(primaryCoin);
    const wb = n(wallet);
    const baseMg = n(hcMargin);
    const lev = n(hcLeverage);
    const takeROE = n(hcTakeROE);
    const cutRatio = n(hcCutRatio) / 100;
    const recovROE = n(hcRecoveryROE);
    const killPct = n(hcKillPct) / 100;
    const fee = n(feeRate) / 100;

    const longEp = n(hcLongEntry);
    const shortEp = n(hcShortEntry);
    const longMg = n(hcLongMargin) || baseMg;
    const shortMg = n(hcShortMargin) || baseMg;

    if (!cp || !wb || !baseMg || !lev) return null;

    // 포지션 계산
    const longNotional = longMg * lev;
    const shortNotional = shortMg * lev;
    const longQty = longEp > 0 ? longNotional / longEp : 0;
    const shortQty = shortEp > 0 ? shortNotional / shortEp : 0;

    // ROE = (미실현손익 / 전략마진) × 100
    const longPnL = longQty > 0 ? (cp - longEp) * longQty : 0;
    const shortPnL = shortQty > 0 ? (shortEp - cp) * shortQty : 0;
    const longROE = baseMg > 0 ? (longPnL / baseMg) * 100 : 0;
    const shortROE = baseMg > 0 ? (shortPnL / baseMg) * 100 : 0;

    // 밸런스 비율
    const ratio = longMg > 0 && shortMg > 0 ? Math.max(longMg, shortMg) / Math.min(longMg, shortMg) : 0;
    const isBalanced = Math.abs(longMg - shortMg) < baseMg * 0.1; // 10% 이내면 balanced

    // 상태 판별
    let state = 1; // 기본 Balanced
    let winner = null; // "long" | "short"
    let loser = null;
    let winnerROE = 0, loserROE = 0;

    if (!isBalanced) {
      // 2:1 비율 — Imbalanced
      state = 2;
      if (longMg > shortMg) {
        winner = "long"; loser = "short";
        winnerROE = longROE; loserROE = shortROE;
      } else {
        winner = "short"; loser = "long";
        winnerROE = shortROE; loserROE = longROE;
      }
      // 복구 조건 체크: loser가 recovROE 이상이면 state 3
      if (loserROE >= recovROE) {
        state = 3;
      }
    } else {
      // Balanced — winner/loser 판별
      if (longROE > shortROE) {
        winner = "long"; loser = "short";
      } else {
        winner = "short"; loser = "long";
      }
      winnerROE = winner === "long" ? longROE : shortROE;
      loserROE = loser === "long" ? longROE : shortROE;
    }

    // 트리거 가격 역산
    // ROE = ((CP - EP) * qty / baseMg) * 100 = takeROE
    // for long: CP = EP + (takeROE/100 * baseMg / qty)
    // for short: CP = EP - (takeROE/100 * baseMg / qty)
    let longTriggerPrice = null, shortTriggerPrice = null;
    if (longQty > 0) longTriggerPrice = longEp + (takeROE / 100 * baseMg) / longQty;
    if (shortQty > 0) shortTriggerPrice = shortEp - (takeROE / 100 * baseMg) / shortQty;

    // 복구 가격 역산 (loser의 ROE가 recovROE가 되는 가격)
    let recoveryPrice = null;
    if (state === 2 && loser) {
      const loserEp = loser === "long" ? longEp : shortEp;
      const loserQty = loser === "long" ? longQty : shortQty;
      const loserMgNow = loser === "long" ? longMg : shortMg;
      if (loserQty > 0) {
        if (loser === "long") {
          recoveryPrice = loserEp + (recovROE / 100 * baseMg) / loserQty;
        } else {
          recoveryPrice = loserEp - (recovROE / 100 * baseMg) / loserQty;
        }
      }
    }

    // 프로그레스: winner ROE / takeROE
    const winnerProgress = takeROE > 0 ? Math.min(Math.max(winnerROE / takeROE, 0), 1) : 0;

    // 복구 프로그레스
    let recoveryProgress = 0;
    if (state === 2 && loserROE < recovROE) {
      // loser가 심한 마이너스에서 0%까지 올라와야 함
      const loserBasePnL = loser === "long" ? longPnL : shortPnL;
      const loserTargetPnL = recovROE / 100 * baseMg;
      const range = Math.abs(loserTargetPnL - loserBasePnL);
      recoveryProgress = range > 0 ? Math.min(1 - Math.abs(loserBasePnL - loserTargetPnL) / (Math.abs(loserBasePnL) + Math.abs(loserTargetPnL) + 0.01), 1) : 1;
    }

    // 킬 스위치
    const killThreshold = wb * (1 - killPct);
    const totalPnL = longPnL + shortPnL;
    const equity = wb + totalPnL;
    const equityPct = wb > 0 ? (equity / wb) * 100 : 100;
    const killAlert = equity <= killThreshold;

    // 상태별 액션 + 손익 시뮬레이션
    let actions = [];
    let cycleProfit = null;

    const buildCycleProfit = (wROE, lROE, wSide, lSide) => {
      const wPnL = wSide === "long" ? longPnL : shortPnL;
      const wQty = wSide === "long" ? longQty : shortQty;
      const wNotional = wSide === "long" ? longNotional : shortNotional;
      const lPnL = lSide === "long" ? longPnL : shortPnL;
      const lQty = lSide === "long" ? longQty : shortQty;
      const lNotional = lSide === "long" ? longNotional : shortNotional;
      const lMg = lSide === "long" ? longMg : shortMg;

      const winCloseFee = wQty * cp * fee;
      const reentryNotional = baseMg * lev;
      const reentryFee = reentryNotional * fee;
      const loserCutPnL = lPnL * cutRatio; // 음수
      const loserCutFee = lQty * cutRatio * cp * fee;

      const netProfit = wPnL - winCloseFee - reentryFee + loserCutPnL - loserCutFee;
      const totalVolume = wNotional + reentryNotional + lNotional * cutRatio;

      return {
        winProfit: wPnL, winCloseFee, reentryFee,
        loserCutPnL, loserCutFee, netProfit, totalVolume,
        loserRemainMg: lMg * (1 - cutRatio),
      };
    };

    // State 1: winner가 takeROE 도달
    if (state === 1 && winnerROE >= takeROE) {
      cycleProfit = buildCycleProfit(winnerROE, loserROE, winner, loser);
      actions = [
        { label: `${winner === "long" ? "롱" : "숏"} 전량 익절`, detail: `수익 +${fmt(cycleProfit.winProfit)} (수수료 -${fmt(cycleProfit.winCloseFee)})`, type: "profit" },
        { label: `${winner === "long" ? "롱" : "숏"} ${fmt(baseMg, 0)} USDT 재진입`, detail: `수수료 -${fmt(cycleProfit.reentryFee)}`, type: "entry" },
        { label: `${loser === "long" ? "롱" : "숏"} ${n(hcCutRatio)}% 손절`, detail: `손실 ${fmt(cycleProfit.loserCutPnL)} (수수료 -${fmt(cycleProfit.loserCutFee)})`, type: "loss" },
      ];
    }
    // State 2: winner가 또 takeROE 도달 (원웨이 시나리오 B)
    else if (state === 2 && winnerROE >= takeROE) {
      cycleProfit = buildCycleProfit(winnerROE, loserROE, winner, loser);
      actions = [
        { label: `${winner === "long" ? "롱" : "숏"} 전량 익절`, detail: `수익 +${fmt(cycleProfit.winProfit)} (수수료 -${fmt(cycleProfit.winCloseFee)})`, type: "profit" },
        { label: `${winner === "long" ? "롱" : "숏"} ${fmt(baseMg, 0)} USDT 재진입`, detail: `수수료 -${fmt(cycleProfit.reentryFee)}`, type: "entry" },
        { label: `${loser === "long" ? "롱" : "숏"} 잔여 ${n(hcCutRatio)}% 추가 손절`, detail: `손실 ${fmt(cycleProfit.loserCutPnL)} → 잔여 ${fmt(cycleProfit.loserRemainMg, 0)}`, type: "loss" },
      ];
    }
    // State 3: loser 복구
    else if (state === 3) {
      const fillAmount = baseMg - (loser === "long" ? longMg : shortMg);
      const fillFee = fillAmount * lev * fee;
      actions = [
        { label: `${loser === "long" ? "롱" : "숏"} ${fmt(fillAmount, 0)} USDT 추가 진입`, detail: `마진 ${fmt(baseMg, 0)}으로 복구 (수수료 -${fmt(fillFee)})`, type: "recovery" },
      ];
    }

    // 알림 가격 배열
    const alertPrices = [];
    if (longTriggerPrice && longTriggerPrice > 0) {
      alertPrices.push({ label: "롱 익절 트리거", price: longTriggerPrice, color: "#34d399" });
    }
    if (shortTriggerPrice && shortTriggerPrice > 0) {
      alertPrices.push({ label: "숏 익절 트리거", price: shortTriggerPrice, color: "#f87171" });
    }
    if (recoveryPrice && recoveryPrice > 0) {
      alertPrices.push({ label: `${loser === "long" ? "롱" : "숏"} 복구 (본전)`, price: recoveryPrice, color: "#0ea5e9" });
    }

    // 킬 스위치 근접 가격 역산
    // equity(P) = wb + longQty*(P-longEp) + shortQty*(shortEp-P)
    // = wb + P*(longQty-shortQty) - longQty*longEp + shortQty*shortEp
    // killThreshold = wb + P*(longQty-shortQty) - longQty*longEp + shortQty*shortEp
    let killPrice = null;
    if (longQty > 0 && shortQty > 0) {
      const netQty = longQty - shortQty;
      const constPart = wb - longQty * longEp + shortQty * shortEp;
      if (Math.abs(netQty) > 1e-12) {
        const kp = (killThreshold - constPart) / netQty;
        if (kp > 0) killPrice = kp;
      }
    }
    if (killPrice && killPrice > 0) {
      alertPrices.push({ label: "⚠ 킬 스위치", price: killPrice, color: "#f87171" });
    }

    // 원웨이 시나리오 (연속 +40% 시 loser 축소 경로)
    const onewayScenario = [];
    if (longEp > 0 && shortEp > 0 && baseMg > 0) {
      let simLoserMg = isBalanced ? baseMg : Math.min(longMg, shortMg);
      let simCumProfit = 0;
      let simCumVolume = 0;
      for (let i = 0; i < 6 && simLoserMg > 1; i++) {
        const profit = takeROE / 100 * baseMg;
        const loss = (simLoserMg * cutRatio) * (takeROE / 100); // approximate loss
        simCumProfit += profit - loss;
        simCumVolume += baseMg * lev * 2 + simLoserMg * cutRatio * lev;
        simLoserMg = simLoserMg * (1 - cutRatio);
        onewayScenario.push({
          cycle: i + 1, loserMg: simLoserMg,
          cumProfit: simCumProfit, cumVolume: simCumVolume,
        });
      }
    }

    return {
      state, winner, loser,
      longPnL, shortPnL, longROE, shortROE,
      longMg, shortMg, longEp, shortEp,
      longQty, shortQty, longNotional, shortNotional,
      winnerROE, loserROE, winnerProgress,
      longTriggerPrice, shortTriggerPrice, recoveryPrice,
      recoveryProgress,
      actions, cycleProfit, alertPrices, killPrice,
      killThreshold, equity, equityPct, killAlert, totalPnL,
      isBalanced, ratio, onewayScenario,
      baseMg, lev, takeROE, cutRatio, recovROE, fee,
    };
  }, [coinPrices, wallet, feeRate, hcMargin, hcLeverage, hcTakeROE, hcCutRatio, hcRecoveryROE, hcKillPct,
      hcLongEntry, hcShortEntry, hcLongMargin, hcShortMargin]);

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */
  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input[type=number]{-moz-appearance:textfield;appearance:textfield}
        input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:2px}
        select{cursor:pointer}
      `}</style>

      <div style={S.wrap}>
        {/* HEADER */}
        <header style={S.hdr}>
          <div style={S.hdrRow}>
            <div style={{ ...S.hdrDot, background: activeColor, boxShadow: `0 0 8px ${activeColor}44` }} />
            <span style={S.hdrBadge}>CROSS MARGIN · FUTURES</span>
          </div>
          <h1 style={S.hdrTitle}>물타기 · 불타기 시뮬레이터</h1>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <p style={S.hdrSub}>다중 포지션 · 평단가 · 청산가 · 역계산 · 양방향 전략</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {saveStatus === "saved" && (
                <span style={{ fontSize: 9, color: "#34d399", fontFamily: "'DM Sans'" }}>
                  💾 저장됨
                </span>
              )}
              {saveStatus === "saving" && (
                <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "'DM Sans'" }}>
                  저장 중...
                </span>
              )}
              <button onClick={handleReset} style={{
                fontSize: 9, padding: "3px 8px", borderRadius: 4,
                border: "1px solid #1e1e2e", background: "transparent",
                color: "#4b5563", cursor: "pointer", fontFamily: "'DM Sans'",
              }} title="현재 프로필 데이터 초기화">
                초기화
              </button>
            </div>
          </div>
        </header>

        {/* ══════ PROFILE SELECTOR BAR ══════ */}
        <div ref={profileDropdownRef} style={{
          position: "relative", marginBottom: 16,
          padding: "10px 14px", borderRadius: 10,
          background: "#08080f", border: `1px solid ${activeColor}33`,
          fontFamily: "'DM Sans'",
        }}>
          {/* 상단: 셀렉터 + 액션 버튼 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* 프로필 선택 버튼 */}
            <button
              onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
              style={{
                flex: 1, display: "flex", alignItems: "center", gap: 8,
                padding: "8px 12px", borderRadius: 8,
                background: profileDropdownOpen ? "#0a0a18" : "transparent",
                border: `1px solid ${profileDropdownOpen ? activeColor + "44" : "#1e1e2e"}`,
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: activeColor, boxShadow: `0 0 6px ${activeColor}66`,
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", textAlign: "left", flex: 1 }}>
                {activeProfile?.name || "프로필 선택"}
              </span>
              <span style={{ fontSize: 10, color: "#4b5563", transform: profileDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
            </button>
            {/* 새 프로필 */}
            <button
              onClick={() => {
                setProfileModalName("");
                setProfileModalColor(PROFILE_COLORS[(profiles.length) % PROFILE_COLORS.length].id);
                setProfileModal("create");
                setProfileDropdownOpen(false);
              }}
              style={{
                padding: "8px 12px", fontSize: 11, fontWeight: 600, borderRadius: 8,
                border: "1px solid #1e1e2e", background: "transparent",
                color: "#0ea5e9", cursor: "pointer", whiteSpace: "nowrap",
              }}
            >＋ 새 프로필</button>
          </div>

          {/* 드롭다운 목록 */}
          {profileDropdownOpen && profiles.length > 0 && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100,
              marginTop: 4, padding: 6, borderRadius: 10,
              background: "#0c0c16", border: "1px solid #1e1e2e",
              boxShadow: "0 12px 40px #00000088",
              maxHeight: 320, overflowY: "auto",
            }}>
              {[...profiles].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).map((p) => {
                const pColor = PROFILE_COLORS.find(c => c.id === p.colorId)?.hex || "#34d399";
                const isActive = p.id === activeProfileId;
                return (
                  <div key={p.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                    background: isActive ? `${pColor}12` : "transparent",
                    border: isActive ? `1px solid ${pColor}33` : "1px solid transparent",
                    marginBottom: 2, transition: "all 0.15s",
                  }}
                    onClick={() => !isActive && switchProfile(p.id)}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#ffffff06"; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: pColor, boxShadow: `0 0 6px ${pColor}44`,
                      flexShrink: 0,
                    }} />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: isActive ? 600 : 400, color: isActive ? "#f1f5f9" : "#94a3b8" }}>
                      {p.name}
                    </span>
                    {isActive && <span style={{ fontSize: 9, color: pColor, fontWeight: 600 }}>활성</span>}
                    {/* 편집/삭제 버튼 */}
                    <button onClick={(e) => {
                      e.stopPropagation();
                      setProfileModalName(p.name);
                      setProfileModalColor(p.colorId || "emerald");
                      setProfileModal("rename-" + p.id);
                      setProfileDropdownOpen(false);
                    }} style={{
                      padding: "2px 6px", fontSize: 10, border: "1px solid #1e1e2e",
                      borderRadius: 4, background: "transparent", color: "#6b7280",
                      cursor: "pointer",
                    }}>✏️</button>
                    {profiles.length > 1 && (
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setProfileDropdownOpen(false);
                        deleteProfile(p.id);
                      }} style={{
                        padding: "2px 6px", fontSize: 10, border: "1px solid #1e1e2e",
                        borderRadius: 4, background: "transparent", color: "#f87171",
                        cursor: "pointer",
                      }}>🗑</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 프로필 생성/편집 모달 */}
          {profileModal && (
            <div style={{
              position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
              background: "#000000aa", zIndex: 200,
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 20,
            }} onClick={() => setProfileModal(null)}>
              <div style={{
                width: "100%", maxWidth: 360, padding: 24, borderRadius: 14,
                background: "#0c0c16", border: "1px solid #1e1e2e",
                boxShadow: "0 20px 60px #000000cc",
                fontFamily: "'DM Sans'",
              }} onClick={(e) => e.stopPropagation()}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>
                  {profileModal === "create" ? "새 프로필 만들기" : "프로필 편집"}
                </div>
                {/* 이름 입력 */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>프로필 이름</div>
                  <input
                    type="text" value={profileModalName}
                    onChange={(e) => setProfileModalName(e.target.value)}
                    placeholder="예: 김민수 ETH 물타기"
                    maxLength={30}
                    style={{
                      ...S.inp, fontSize: 13,
                    }}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (profileModal === "create") {
                          createProfile(profileModalName.trim(), profileModalColor);
                        } else {
                          const pid = profileModal.replace("rename-", "");
                          renameProfile(pid, profileModalName.trim(), profileModalColor);
                        }
                        setProfileModal(null);
                      }
                    }}
                  />
                </div>
                {/* 색상 선택 */}
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>색상 태그</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PROFILE_COLORS.map((c) => (
                      <button key={c.id} onClick={() => setProfileModalColor(c.id)} style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: profileModalColor === c.id ? `${c.hex}22` : "transparent",
                        border: `2px solid ${profileModalColor === c.id ? c.hex : "#1e1e2e"}`,
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "all 0.15s",
                      }}>
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: c.hex,
                          boxShadow: profileModalColor === c.id ? `0 0 8px ${c.hex}66` : "none",
                        }} />
                      </button>
                    ))}
                  </div>
                </div>
                {/* 액션 버튼 */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setProfileModal(null)} style={{
                    flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 600,
                    borderRadius: 8, border: "1px solid #1e1e2e", background: "transparent",
                    color: "#6b7280", cursor: "pointer",
                  }}>취소</button>
                  <button onClick={() => {
                    const name = profileModalName.trim();
                    if (profileModal === "create") {
                      createProfile(name, profileModalColor);
                    } else {
                      const pid = profileModal.replace("rename-", "");
                      renameProfile(pid, name, profileModalColor);
                    }
                    setProfileModal(null);
                  }} style={{
                    flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 600,
                    borderRadius: 8, border: `1px solid ${PROFILE_COLORS.find(c => c.id === profileModalColor)?.hex || "#34d399"}44`,
                    background: `${PROFILE_COLORS.find(c => c.id === profileModalColor)?.hex || "#34d399"}15`,
                    color: PROFILE_COLORS.find(c => c.id === profileModalColor)?.hex || "#34d399",
                    cursor: "pointer",
                  }}>{profileModal === "create" ? "생성" : "저장"}</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* TAB NAVIGATION */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[
            { id: "sim", label: "물타기 · 불타기" },
            { id: "hedge", label: "헷지 사이클" },
          ].map((tab) => (
            <button key={tab.id} onClick={() => setAppTab(tab.id)} style={{
              flex: 1, padding: "12px 0", fontSize: 13, fontWeight: 700, borderRadius: 10,
              border: `1px solid ${appTab === tab.id ? "#0ea5e944" : "#1e1e2e"}`,
              background: appTab === tab.id ? "#0ea5e910" : "transparent",
              color: appTab === tab.id ? "#0ea5e9" : "#4b5563",
              cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.15s",
              letterSpacing: 0.5,
            }}>{tab.label}</button>
          ))}
        </div>

        {/* ══════ SIMULATOR TAB ══════ */}
        {appTab === "sim" && (<>

        {/* ① ACCOUNT & MARKET */}
        <Sec label="계좌 & 시장" />
        <div style={S.grid2}>
          <Fld label="지갑 총 잔고 (USDT)">
            <Inp value={wallet} onChange={setWallet} ph="거래소에서 확인" />
          </Fld>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Sans'" }}>
                현재가 ($)
              </div>
              <button onClick={() => {
                if (priceMode === "live") { setPriceMode("manual"); }
                else { setPriceMode("live"); setFetchError(false); }
              }} style={{
                ...S.miniBtn, fontSize: 9, padding: "2px 8px",
                color: priceMode === "live" ? "#34d399" : "#6b7280",
                borderColor: priceMode === "live" ? "#34d39933" : "#1e1e2e",
              }}>
                {priceMode === "live" ? "✎ 수동 전환" : "↻ 실시간"}
              </button>
            </div>
            {usedCoins.map(coin => (
              <div key={coin} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", width: 40, textAlign: "right", fontFamily: "'IBM Plex Mono'" }}>{coin}</span>
                <input
                  type="number"
                  value={coinPrices[coin] || ""}
                  placeholder={`${coin}/USDT`}
                  readOnly={priceMode === "live"}
                  onChange={(e) => setCp(coin, e.target.value)}
                  style={{
                    ...S.inp, flex: 1,
                    borderColor: priceMode === "live" ? "#34d39944" : "#1e1e2e",
                    background: priceMode === "live" ? "#060d08" : "#0a0a12",
                    cursor: priceMode === "live" ? "default" : "text",
                    transition: "color 0.3s, border-color 0.3s, background 0.3s",
                  }}
                />
              </div>
            ))}
            <div style={{ fontSize: 9, marginTop: 3, color: "#4b5563", fontFamily: "'DM Sans'" }}>
              {fetchError ? (
                <span style={{ color: "#f87171" }}>연결 실패 · 수동 입력 모드</span>
              ) : priceMode === "live" ? (
                <span style={{ color: "#34d399", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{
                    display: "inline-block", width: 4, height: 4, borderRadius: "50%",
                    background: "#34d399", boxShadow: "0 0 6px #34d39966",
                  }} />
                  Binance Futures 실시간 · {usedCoins.join(", ")}
                </span>
              ) : (
                <span>수동 입력 중 · <span
                  onClick={() => { setPriceMode("live"); setFetchError(false); }}
                  style={{ color: "#0ea5e9", cursor: "pointer", textDecoration: "underline" }}
                >실시간 전환</span></span>
              )}
            </div>
          </div>
        </div>
        <div style={{ ...S.grid2, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>
              거래소 강제 청산가 ($)
            </div>
            {usedCoins.map(coin => {
              const isRef = calc?.calcRefCoin === coin;
              const hasManual = !!(coinLiqPrices[coin] && n(coinLiqPrices[coin]) > 0);
              const autoVal = calc?.autoLiqPrices?.[coin];
              const hasAuto = !isRef && !hasManual && autoVal != null && autoVal > 0;
              return (
                <div key={coin} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", width: 40, textAlign: "right", fontFamily: "'IBM Plex Mono'" }}>{coin}</span>
                  {hasAuto ? (
                    <div style={{
                      ...S.inp, flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between",
                      background: "#060a10", borderColor: "#0ea5e922", cursor: "default",
                    }}>
                      <span style={{ color: "#0ea5e9", fontSize: 13, fontWeight: 500 }}>{fmt(autoVal, autoVal > 100 ? 2 : 4)}</span>
                      <span style={{ fontSize: 9, color: "#0ea5e966", fontFamily: "'DM Sans'", whiteSpace: "nowrap", marginLeft: 8 }}>자동</span>
                    </div>
                  ) : (
                    <Inp value={coinLiqPrices[coin] || ""} onChange={(v) => setLiqPrice(coin, v)} ph="거래소에서 확인" />
                  )}
                </div>
              );
            })}
            {usedCoins.length > 1 && calc?.mmRate && (
              <div style={{ fontSize: 9, color: "#0ea5e966", marginTop: 2, fontFamily: "'DM Sans'" }}>
                💡 {calc.calcRefCoin} 청산가 기준으로 타 코인 자동 계산 (현재가 고정 가정)
              </div>
            )}
          </div>
          <Fld label="수수료율 (%)">
            <Inp value={feeRate} onChange={setFeeRate} ph="0.04" />
          </Fld>
        </div>

        {/* ② POSITIONS */}
        <Sec label="기존 포지션" />
        {positions.map((pos, idx) => (
          <PosCard key={pos.id} pos={pos} idx={idx}
            isSel={pos.id === selId}
            isPyraLocked={pyraMode && pos.id === pyraLockedId}
            isPyraCounter={pyraMode && pos.id === pyraCounterId}
            onSelect={() => selectPos(pos.id)}
            onPyra={() => selectPyra(pos.id)}
            onUpdate={updPos}
            onRemove={() => rmPos(pos.id)}
            canRemove={positions.length > 1}
            cp={getCp(pos.coin)} fee={n(feeRate)/100} />
        ))}
        <button onClick={addPos} style={S.addBtn}>+ 포지션 추가</button>

        {/* 온보딩 가이드: 필수값 미입력 시 표시 */}
        {(!n(wallet) || !positions.some(p => n(p.entryPrice) > 0 && n(p.margin) > 0)) && (
          <div style={{
            marginTop: 16, padding: 20, borderRadius: 12,
            background: "linear-gradient(135deg, #0a0e1a 0%, #080c16 100%)",
            border: "1px solid #0ea5e922",
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0ea5e9", fontFamily: "'DM Sans'", marginBottom: 12 }}>
              📋 시작하기
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.8, fontFamily: "'DM Sans'" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                <span style={{ color: !n(wallet) ? "#f59e0b" : "#34d399", fontWeight: 700, minWidth: 16 }}>{!n(wallet) ? "①" : "✓"}</span>
                <span>거래소에서 <strong style={{ color: "#e2e8f0" }}>지갑 총 잔고</strong>를 확인하고 입력하세요</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                <span style={{ color: !positions.some(p => n(p.entryPrice) > 0 && n(p.margin) > 0) ? "#f59e0b" : "#34d399", fontWeight: 700, minWidth: 16 }}>
                  {!positions.some(p => n(p.entryPrice) > 0 && n(p.margin) > 0) ? "②" : "✓"}
                </span>
                <div>
                  <span>보유 중인 <strong style={{ color: "#e2e8f0" }}>모든 포지션</strong>의 <strong style={{ color: "#e2e8f0" }}>오픈 균일가</strong>, <strong style={{ color: "#e2e8f0" }}>마진</strong>, <strong style={{ color: "#e2e8f0" }}>레버리지</strong>를 입력하세요</span>
                  <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>※ 교차 마진에서는 모든 포지션이 청산가에 영향을 줍니다</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                <span style={{ color: !Object.values(coinLiqPrices).some(v => n(v) > 0) ? "#f59e0b" : "#34d399", fontWeight: 700, minWidth: 16 }}>
                  {!Object.values(coinLiqPrices).some(v => n(v) > 0) ? "③" : "✓"}
                </span>
                <div>
                  <span>거래소에 표시된 <strong style={{ color: "#e2e8f0" }}>강제 청산가</strong>를 입력하세요</span>
                  <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>※ 미입력 시 청산가 예측 기능이 비활성화됩니다</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ color: hasAnyPrice ? "#34d399" : "#f59e0b", fontWeight: 700, minWidth: 16 }}>{hasAnyPrice ? "✓" : "④"}</span>
                <span style={{ color: hasAnyPrice ? "#94a3b8" : "#6b7280" }}>현재가에서 <strong style={{ color: hasAnyPrice ? "#94a3b8" : "#e2e8f0" }}>실시간 전환</strong>을 누르거나 직접 입력하면 시뮬레이션이 시작됩니다</span>
              </div>
            </div>
          </div>
        )}

        {/* ③ ACCOUNT SUMMARY */}
        {calc && hasAnyPrice && (
          <>
            <Sec label="계좌 요약" />
            <div style={S.summaryGrid}>
              <SumCard label="총 미실현 PnL" value={`${fmtS(calc.totalPnL)} USDT`}
                color={calc.totalPnL >= 0 ? "#34d399" : "#f87171"} />
              <SumCard label="유효 잔고 (Equity)" value={`${fmt(calc.equity)} USDT`}
                color="#e2e8f0" />
              <SumCard label="사용 마진" value={`${fmt(calc.totalMargin)} USDT`}
                color="#94a3b8" />
              <SumCard label="사용 가능" value={`${fmt(calc.freeMargin)} USDT`}
                color={calc.freeMargin > 0 ? "#34d399" : "#f87171"}
                sub="미실현 이익 미반영 (Bybit)" />
            </div>

            {/* Available amount target */}
            <div style={S.availBox}>
              <div style={S.availRow}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>여유 마진 목표</div>
                  <Inp value={targetAvail} onChange={setTargetAvail} ph="목표 금액 (USDT)" />
                </div>
                <div style={{ flex: 1, paddingLeft: 12, display: "flex", alignItems: "flex-end" }}>
                  {calc.availCalc ? (
                    calc.availCalc.sufficient ? (
                      <div style={{ fontSize: 13, color: "#34d399", fontWeight: 600, paddingBottom: 10 }}>
                        ✓ 현재 충분
                      </div>
                    ) : calc.availCalc.impossible ? (
                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ fontSize: 10, color: "#f87171", fontWeight: 600, marginBottom: 4 }}>
                          가격 변동만으로 도달 불가
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>
                          최대 확보 가능: <span style={{ color: "#f59e0b", fontWeight: 600 }}>{fmt(calc.availCalc.maxAvail)} USDT</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                          (${fmt(calc.availCalc.maxAvailPrice)} · {fmtS(calc.availCalc.maxChangePct)}%)
                        </div>
                        <div style={{ fontSize: 10, color: "#f87171", marginTop: 2 }}>
                          부족분 {fmt(calc.availCalc.shortfall)} USDT → 포지션 축소 필요
                        </div>
                      </div>
                    ) : (
                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>필요 가격</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#0ea5e9", fontFamily: "'DM Sans'" }}>
                          ${fmt(calc.availCalc.neededPrice)}
                        </div>
                        <div style={{ fontSize: 11, color: calc.availCalc.direction === "up" ? "#34d399" : "#f87171", marginTop: 2 }}>
                          현재가 대비 {fmtS(calc.availCalc.changePct)}% {calc.availCalc.direction === "up" ? "↑" : "↓"}
                        </div>
                      </div>
                    )
                  ) : (
                    <div style={{ fontSize: 11, color: "#333", paddingBottom: 10 }}>
                      금액 입력 시 필요 가격 표시
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Liquidation info */}
            {calc?.exLiq > 0 ? (
              <div style={S.liqBar}>
                <div style={S.liqBarInner}>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
                      강제 청산가 <span style={{ color: "#4b5563" }}>({calc.calcRefCoin})</span>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                      ${fmt(calc.exLiq)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>현재가 대비 여유</div>
                    <div style={{
                      fontSize: 20, fontWeight: 700, fontFamily: "'DM Sans'",
                      color: Math.abs(calc.liqDistPct || 0) > 50 ? "#34d399" : Math.abs(calc.liqDistPct || 0) > 20 ? "#f59e0b" : "#f87171",
                    }}>
                      {calc.liqDistPct != null ? `${fmt(Math.abs(calc.liqDistPct))}%` : "—"}
                    </div>
                  </div>
                </div>
                {/* 다중 코인 자동계산 청산가 */}
                {Object.keys(calc.autoLiqPrices).length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1e1e2e" }}>
                    {Object.entries(calc.autoLiqPrices).map(([coin, liq]) => {
                      const coinCp = getCp(coin);
                      const dist = coinCp > 0 ? ((coinCp - liq) / coinCp) * 100 : null;
                      return (
                        <div key={coin} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", fontFamily: "'IBM Plex Mono'", width: 40 }}>{coin}</span>
                            <span style={{ fontSize: 14, fontWeight: 600, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                              ${fmt(liq, liq > 100 ? 2 : 4)}
                            </span>
                            <span style={{ fontSize: 9, color: "#0ea5e966", fontFamily: "'DM Sans'" }}>자동</span>
                          </div>
                          {dist != null && (
                            <span style={{
                              fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans'",
                              color: Math.abs(dist) > 50 ? "#34d399" : Math.abs(dist) > 20 ? "#f59e0b" : "#f87171",
                            }}>
                              여유 {fmt(Math.abs(dist))}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Visual bar */}
                {calc.liqDistPct != null && (
                  <div style={S.liqVisual}>
                    <div style={S.liqTrack}>
                      <div style={{
                        ...S.liqFill,
                        width: `${Math.min(Math.abs(calc.liqDistPct), 100)}%`,
                        background: Math.abs(calc.liqDistPct) > 50 ? "#34d399" : Math.abs(calc.liqDistPct) > 20 ? "#f59e0b" : "#f87171",
                      }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#4b5563", marginTop: 3 }}>
                      <span>청산</span>
                      <span>현재가</span>
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div style={S.liqEmpty}>
                거래소 강제 청산가를 입력하면 청산가 분석이 표시됩니다
              </div>
            )}

            {/* ── 🔥 Simultaneous close summary (pyra mode) ── */}
            {pyraMode && calc.pyraResult && calc.cp > 0 && (
              <div style={{
                marginTop: 10, padding: 16, borderRadius: 10,
                background: "#0c0a04", border: "1px solid #f59e0b33",
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 10 }}>
                  🔥 동시 청산 시
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>합산 PnL</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: calc.pyraResult.combinedPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                      {fmtS(calc.pyraResult.combinedPnL)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>순손익 (수수료 후)</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: calc.pyraResult.simultaneousClose >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                      {fmtS(calc.pyraResult.simultaneousClose)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>역전가까지</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                      {calc.pyraResult.reversalPrice
                        ? `${fmtS(calc.pyraResult.reversalDist)}%`
                        : "—"}
                    </div>
                    {calc.pyraResult.reversalPrice && (
                      <div style={{ fontSize: 10, color: "#6b7280" }}>${fmt(calc.pyraResult.reversalPrice)}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ⚖ HEDGE CLOSE CALCULATOR */}
            {calc.hedgePairs && calc.hedgePairs.length > 0 && calc.hedgePairs.map(pair => (
              <div key={`sc-${pair.coin}`}>
                {/* Section header */}
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase",
                  color: "#10b981", fontFamily: "'DM Sans'",
                  margin: "28px 0 10px", display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ width: 3, height: 14, background: "#10b981", borderRadius: 2 }} />
                  동시청산 — {pair.coin}
                </div>

                {/* Position summary + close ratios */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  {/* Long */}
                  <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #34d39933" }}>
                    <div style={{ fontSize: 10, color: "#34d399", fontWeight: 700, marginBottom: 6, fontFamily: "'DM Sans'" }}>롱</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>진입 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fmt(pair.long.ep, pair.long.ep > 100 ? 2 : 4)}</span></div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>마진 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.long.mg)}</span> · {pair.long.lev}x</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>수량 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.long.qty, 4)}</span></div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>청산 비율 (%)</div>
                    <input type="number" value={getScRatio(pair.coin, "long")}
                      onChange={(e) => setScRatio(pair.coin, "long", e.target.value)}
                      style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                      onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                      {[25, 50, 75, 100].map(v => (
                        <button key={v} onClick={() => setScRatio(pair.coin, "long", String(v))} style={{
                          flex: 1, padding: "3px 0", fontSize: 9, fontWeight: 600, borderRadius: 4,
                          cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.12s",
                          border: `1px solid ${getScRatio(pair.coin, "long") === String(v) ? "#10b98166" : "#1e1e2e"}`,
                          background: getScRatio(pair.coin, "long") === String(v) ? "#10b98115" : "transparent",
                          color: getScRatio(pair.coin, "long") === String(v) ? "#10b981" : "#4b5563",
                        }}>{v}%</button>
                      ))}
                    </div>
                  </div>
                  {/* Short */}
                  <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #f8717133" }}>
                    <div style={{ fontSize: 10, color: "#f87171", fontWeight: 700, marginBottom: 6, fontFamily: "'DM Sans'" }}>숏</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>진입 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fmt(pair.short.ep, pair.short.ep > 100 ? 2 : 4)}</span></div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>마진 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.short.mg)}</span> · {pair.short.lev}x</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>수량 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.short.qty, 4)}</span></div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>청산 비율 (%)</div>
                    <input type="number" value={getScRatio(pair.coin, "short")}
                      onChange={(e) => setScRatio(pair.coin, "short", e.target.value)}
                      style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                      onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                      {[25, 50, 75, 100].map(v => (
                        <button key={v} onClick={() => setScRatio(pair.coin, "short", String(v))} style={{
                          flex: 1, padding: "3px 0", fontSize: 9, fontWeight: 600, borderRadius: 4,
                          cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.12s",
                          border: `1px solid ${getScRatio(pair.coin, "short") === String(v) ? "#10b98166" : "#1e1e2e"}`,
                          background: getScRatio(pair.coin, "short") === String(v) ? "#10b98115" : "transparent",
                          color: getScRatio(pair.coin, "short") === String(v) ? "#10b981" : "#4b5563",
                        }}>{v}%</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Fee details */}
                <div style={S.detBox}>
                  <div style={{ ...S.detTitle, color: "#10b981" }}>수수료 내역</div>
                  <div style={S.sl}><span style={{ color: "#6b7280" }}>진입 수수료 (이미 지불)</span><span style={{ color: "#f59e0b" }}>{fmt(pair.entryFees)} USDT</span></div>
                  <div style={S.sl}><span style={{ color: "#6b7280" }}>청산 수수료 (현재가 기준)</span><span style={{ color: "#f59e0b" }}>{fmt(pair.currentCloseFee)} USDT</span></div>
                  <div style={{ ...S.sl, borderBottom: "none", fontWeight: 600 }}><span style={{ color: "#94a3b8" }}>수수료 합계</span><span style={{ color: "#f59e0b" }}>{fmt(pair.entryFees + pair.currentCloseFee)} USDT</span></div>
                </div>

                {/* Break-even prices */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div style={{ padding: 14, borderRadius: 10, background: "#10b98108", border: "1px solid #10b98133", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>본전가 (전체 수수료)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#10b981", fontFamily: "'DM Sans'" }}>
                      {pair.breakevenAll ? `$${fmt(pair.breakevenAll, pair.breakevenAll > 100 ? 2 : 4)}` : "—"}
                    </div>
                    {pair.beAllDist != null && (
                      <div style={{ fontSize: 11, color: pair.beAllDist >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                        현재가 대비 {fmtS(pair.beAllDist)}%
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>본전가 (청산 수수료만)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#94a3b8", fontFamily: "'DM Sans'" }}>
                      {pair.breakevenClose ? `$${fmt(pair.breakevenClose, pair.breakevenClose > 100 ? 2 : 4)}` : "—"}
                    </div>
                    {pair.beCloseDist != null && (
                      <div style={{ fontSize: 11, color: pair.beCloseDist >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                        현재가 대비 {fmtS(pair.beCloseDist)}%
                      </div>
                    )}
                  </div>
                </div>

                {/* Current price summary */}
                <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontFamily: "'DM Sans'" }}>
                    현재가 ${fmt(pair.coinCp, pair.coinCp > 100 ? 2 : 4)} 에서 동시 청산 시
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>롱 PnL</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentLongPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentLongPnL)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>숏 PnL</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentShortPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentShortPnL)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>수수료</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                        -{fmt(pair.entryFees + pair.currentCloseFee)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>순손익</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentNetAll >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentNetAll)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Target profit */}
                <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #10b98122", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#10b981", fontWeight: 700, letterSpacing: 2, marginBottom: 8, fontFamily: "'DM Sans'" }}>목표 익절</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>목표 금액 (USDT)</div>
                      <input type="number" value={getScTarget(pair.coin)}
                        onChange={(e) => setScTarget(pair.coin, e.target.value)}
                        placeholder="0"
                        style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                        onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                        onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    </div>
                    <div style={{ flex: 1, paddingLeft: 4, display: "flex", alignItems: "flex-end" }}>
                      {pair.targetPrice ? (
                        <div style={{ paddingBottom: 2 }}>
                          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>익절가</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: "#10b981", fontFamily: "'DM Sans'" }}>
                            ${fmt(pair.targetPrice, pair.targetPrice > 100 ? 2 : 4)}
                          </div>
                          <div style={{ fontSize: 11, color: pair.targetDist >= 0 ? "#34d399" : "#f87171", marginTop: 1 }}>
                            현재가 대비 {fmtS(pair.targetDist)}%
                          </div>
                        </div>
                      ) : pair.target > 0 ? (
                        <div style={{ fontSize: 11, color: "#f87171", paddingBottom: 10 }}>도달 불가</div>
                      ) : (
                        <div style={{ fontSize: 11, color: "#333", paddingBottom: 10 }}>금액 입력 시 익절가 표시</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Scenario table */}
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <th style={S.th}>가격</th>
                        <th style={{ ...S.th, textAlign: "right" }}>롱 PnL</th>
                        <th style={{ ...S.th, textAlign: "right" }}>숏 PnL</th>
                        <th style={{ ...S.th, textAlign: "right" }}>수수료</th>
                        <th style={{ ...S.th, textAlign: "right" }}>순손익</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pair.scenarios.map((s, i) => (
                        <tr key={i} style={{
                          background: s.isSpecial ? "#10b98108" : s.isCurrent ? "#0ea5e908" : "transparent",
                        }}>
                          <td style={{ ...S.td, fontWeight: s.isSpecial || s.isCurrent ? 600 : 400 }}>
                            <div style={{ fontSize: 12, color: s.isSpecial ? "#10b981" : s.isCurrent ? "#0ea5e9" : "#e2e8f0" }}>
                              ${fmt(s.price, s.price > 100 ? 2 : 4)}
                            </div>
                            <div style={{ fontSize: 9, color: s.isSpecial ? "#10b981" : s.isCurrent ? "#0ea5e9" : "#4b5563" }}>
                              {s.label}
                            </div>
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: s.longPnL >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.longPnL)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: s.shortPnL >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.shortPnL)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: "#f59e0b" }}>
                            -{fmt(s.closeFee + pair.entryFees)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 600, color: s.netAll >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.netAll)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}

        {/* ④ DCA SECTION */}
        {selId && selPos && (
          <>
            <Sec label={`물타기 — ${selPos.coin} ${selPos.dir === "long" ? "롱" : "숏"}`} accent />

            <div style={S.modeRow}>
              {[["sim", "추가 진입"], ["reverse", "목표 평단"], ["close", "부분 청산"]].map(([k, lb]) => (
                <button key={k} onClick={() => setDcaMode(k)} style={{
                  ...S.modeBtn,
                  background: dcaMode === k ? (k === "close" ? "#f8717115" : "#0ea5e915") : "transparent",
                  borderColor: dcaMode === k ? (k === "close" ? "#f8717144" : "#0ea5e944") : "#1e1e2e",
                  color: dcaMode === k ? (k === "close" ? "#f87171" : "#0ea5e9") : "#6b7280",
                }}>{lb}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 10, fontFamily: "'DM Sans'" }}>
              {dcaMode === "sim" && "지정 가격에 추가 매수하면 평단·청산가·ROE가 어떻게 바뀌는지 미리 확인"}
              {dcaMode === "reverse" && "원하는 평단가를 입력하면 필요한 마진/가격을 역으로 계산"}
              {dcaMode === "close" && "지정 비율만큼 포지션을 줄였을 때의 손익과 잔여 포지션 확인"}
            </div>

            {dcaMode === "sim" && (
              <>
                {/* Direct input — always visible */}
                {dcaEntries.map((dca, idx) => (
                  <div key={dca.id} style={S.dcaRow}>
                    <div style={S.dcaNum}>{idx + 1}</div>
                    <div style={{ flex: 1 }}>
                      <PriceInp value={dca.price} onChange={(v) => updDCA(dca.id, "price", v)} ph="진입 예정가 ($)"
                        cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Inp value={dca.margin} onChange={(v) => updDCA(dca.id, "margin", v)} ph="투입금액 (USDT)" />
                      {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={(v) => updDCA(dca.id, "margin", v)} />}
                    </div>
                    {dcaEntries.length > 1 && (
                      <button onClick={() => rmDCA(dca.id)} style={S.rmSm}>×</button>
                    )}
                  </div>
                ))}
                <button onClick={addDCA} style={S.addBtn}>+ 물타기 추가</button>

                {/* Split helper — collapsible */}
                <button onClick={openSplitHelper} style={S.splitToggle}>
                  {splitMode ? "분할 매수 전략 접기 ▲" : "분할 매수 전략 ▼"}
                </button>

                {splitMode && (
                  <div style={S.splitPanel}>
                    <Fld label="총 투입금액 (USDT)">
                      <Inp value={splitTotal} onChange={setSplitTotal} ph="300" />
                      {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={setSplitTotal} />}
                    </Fld>

                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>물타기 가격</div>
                      {splitPrices.map((sp, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                          <div style={{ ...S.dcaNum, width: 20, height: 20, fontSize: 10 }}>{idx + 1}</div>
                          <div style={{ flex: 1 }}>
                            <PriceInp value={sp} onChange={(v) => updSplitPrice(idx, v)} ph={`가격 ${idx + 1}`}
                              cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                          </div>
                          {splitPrices.length > 2 && (
                            <button onClick={() => rmSplitPrice(idx)} style={{ ...S.rmSm, width: 28, height: 32, fontSize: 14 }}>×</button>
                          )}
                        </div>
                      ))}
                      <button onClick={addSplitPrice} style={{ ...S.addBtn, marginTop: 2, fontSize: 11, padding: "6px 0" }}>+ 가격 추가</button>
                      <SplitAutoGen cp={selPos ? getCp(selPos.coin) : 0} isLong={selPos?.dir === "long"} onGenerate={setSplitPrices} />
                    </div>

                    {calc?.splitResult && (
                      <>
                        <div style={{ height: 12 }} />

                        {calc.splitResult.marginInsufficient && (
                          <div style={{ ...S.warnBox, marginBottom: 8, fontSize: 11 }}>
                            ⚠ 사용 가능({fmt(calc.freeMargin)}) &lt; 총 투입({fmt(calc.splitResult.totalMargin)}) USDT
                          </div>
                        )}

                        {/* Strategy cards */}
                        <div style={S.splitGrid}>
                          {calc.splitResult.results.map((sr, i) => {
                            const isBest = i === calc.splitResult.bestIdx;
                            return (
                              <div key={i} style={{
                                ...S.splitCard,
                                borderColor: isBest ? "#0ea5e944" : "#1e1e2e",
                                background: isBest ? "#0a1020" : "#0a0a14",
                              }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: isBest ? "#0ea5e9" : "#94a3b8", fontFamily: "'DM Sans'" }}>
                                    {isBest ? "✦ " : ""}{sr.name}
                                  </div>
                                  <div style={{ fontSize: 9, color: "#4b5563" }}>{sr.desc}</div>
                                </div>

                                <div style={{ marginBottom: 8 }}>
                                  {sr.entries.map((e, j) => (
                                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", padding: "2px 0" }}>
                                      <span>${fmt(e.price, 0)}</span>
                                      <span>{fmt(e.margin, 0)} USDT</span>
                                    </div>
                                  ))}
                                </div>

                                <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 8, marginBottom: 8 }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                                    <span style={{ color: "#6b7280" }}>새 평단</span>
                                    <span style={{ color: isBest ? "#0ea5e9" : "#e2e8f0", fontWeight: 600 }}>${fmt(sr.newAvg)}</span>
                                  </div>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                                    <span style={{ color: "#6b7280" }}>탈출가</span>
                                    <span style={{ color: "#f59e0b" }}>${fmt(sr.breakeven)}</span>
                                  </div>
                                  {calc?.exLiq > 0 && sr.afterLiq != null && (
                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                      <span style={{ color: "#6b7280" }}>청산가</span>
                                      <span style={{ color: "#e2e8f0" }}>${fmt(sr.afterLiq)}</span>
                                    </div>
                                  )}
                                </div>

                                <button onClick={() => {
                                  const newEntries = sr.entries.map((e) => ({
                                    id: uid(),
                                    price: String(e.price),
                                    margin: String(Math.round(e.margin * 100) / 100),
                                  }));
                                  setDcaEntries(newEntries);
                                }} style={{
                                  ...S.applyBtn,
                                  width: "100%", padding: "6px 0", textAlign: "center",
                                  background: isBest ? "#0ea5e918" : "#0ea5e908",
                                }}>채우기</button>
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 6 }}>
                          ✦ 추천: {calc.splitResult.results[calc.splitResult.bestIdx].name} — 평단이 가장 {calc.sel?.dir === "long" ? "낮아짐" : "높아짐"}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {dcaMode === "reverse" && (
              <div style={S.grid2}>
                <Fld label="물타기 진입 예정가 ($)">
                  <PriceInp value={revPrice} onChange={setRevPrice} ph="예: 2700"
                    cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                </Fld>
                <Fld label="목표 평단가 ($)">
                  <Inp value={revTarget} onChange={setRevTarget} ph="예: 3000" />
                </Fld>
              </div>
            )}

            {dcaMode === "close" && (
              <>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontFamily: "'DM Sans'" }}>손절 비율</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[25, 50, 75, 100].map((v) => (
                      <button key={v} onClick={() => setCloseRatio(String(v))} style={{
                        flex: 1, padding: "9px 0", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${n(closeRatio) === v ? "#f8717133" : "#1e1e2e"}`,
                        background: n(closeRatio) === v ? "#f8717112" : "transparent",
                        color: n(closeRatio) === v ? "#f87171" : "#4b5563",
                        fontFamily: "'DM Sans'",
                      }}>{v}%</button>
                    ))}
                  </div>
                </div>
                <div style={S.grid2}>
                  <Fld label="손절 비율 직접 입력 (%)">
                    <Inp value={closeRatio} onChange={setCloseRatio} ph="50" />
                  </Fld>
                  <Fld label="손절 예정가 ($ · 비워두면 현재가)">
                    <PriceInp value={closePrice} onChange={setClosePrice} ph="현재가 기준"
                      cp={selPos ? getCp(selPos.coin) : 0} mode="close" />
                  </Fld>
                </div>
              </>
            )}
          </>
        )}

        {!selId && !pyraMode && (
          <div style={S.empty}>↑ 포지션 카드에서 [물타기] 버튼을 눌러 추가 진입 · 목표 평단 · 부분 청산을 계산하세요</div>
        )}

        {/* ═══ ④-B PYRAMIDING SECTION ═══ */}
        {pyraMode && calc?.pyraCounter && (() => {
          const counter = calc.pyraCounter; // 수익 포지션 (불타기 대상)
          const locked = calc.pyraLocked;   // 물린 포지션 (잠금) — 있을수도 없을수도
          const counterPos = positions.find((p) => p.id === pyraCounterId);
          const counterDirKr = counter.dir === "long" ? "롱" : "숏";
          const lockedDirKr = counter.dir === "long" ? "숏" : "롱";
          const lockedDirEn = counter.dir === "long" ? "short" : "long";

          return (
            <>
              <Sec label={`🔥 불타기 — ${counterPos?.coin || ""} ${counterDirKr} ↔ ${lockedDirKr} (잠금)`} pyra />

              {/* Locked (losing) position selection if not auto-detected */}
              {!pyraLockedId && (() => {
                const candidates = positions.filter((p) => p.id !== pyraCounterId && p.dir === lockedDirEn && p.coin === (counterPos?.coin || ""));
                if (candidates.length > 1) return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>물린 포지션 선택:</div>
                    {candidates.map((c) => (
                      <button key={c.id} onClick={() => setPyraLockedId(c.id)} style={{
                        ...S.miniBtn, marginRight: 6, marginBottom: 4,
                        color: "#6b7280", borderColor: "#6b728044",
                      }}>
                        {c.dir === "long" ? "롱" : "숏"} ${c.entryPrice} · {c.margin} USDT
                      </button>
                    ))}
                  </div>
                );
                if (candidates.length === 0) return (
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12, padding: 10, borderRadius: 8, background: "#0a0a12", border: "1px dashed #1e1e2e" }}>
                    반대 방향({lockedDirKr}) 포지션이 없습니다. 포지션을 추가하거나 불타기 진입만 시뮬레이션합니다.
                  </div>
                );
                return null;
              })()}

              {/* Show locked (losing) position info */}
              {locked && (
                <div style={{ padding: 10, borderRadius: 8, background: "#0a0a12", border: "1px solid #1e1e2e", marginBottom: 12, fontSize: 12 }}>
                  <div style={{ color: "#6b7280", fontSize: 10, marginBottom: 4 }}>🔒 물린 포지션 (고정)</div>
                  <span style={{ color: "#94a3b8" }}>
                    {lockedDirKr} · 균일가 ${fmt(locked.ep)} · 마진 {fmt(locked.mg)} · PnL{" "}
                    <span style={{ color: locked.pnl >= 0 ? "#34d399" : "#f87171" }}>
                      {fmtS(locked.pnl)} ({fmtS(locked.roe)}%)
                    </span>
                  </span>
                </div>
              )}

              {/* Sub-mode tabs */}
              <div style={S.modeRow}>
                {[["sim", "추가 진입"], ["reverse", "목표 역전가"]].map(([k, lb]) => (
                  <button key={k} onClick={() => setPyraSubMode(k)} style={{
                    ...S.modeBtn,
                    background: pyraSubMode === k ? "#f59e0b15" : "transparent",
                    borderColor: pyraSubMode === k ? "#f59e0b44" : "#1e1e2e",
                    color: pyraSubMode === k ? "#f59e0b" : "#6b7280",
                  }}>{lb}</button>
                ))}
              </div>

              {pyraSubMode === "sim" && (
                <>
                  {/* Direct input */}
                  {pyraEntries.map((entry, idx) => (
                    <div key={entry.id} style={S.dcaRow}>
                      <div style={{ ...S.dcaNum, background: "#f59e0b15", borderColor: "#f59e0b33", color: "#f59e0b" }}>
                        {calc.pyraCounter ? idx + 1 : idx === 0 ? "①" : idx}
                      </div>
                      <div style={{ flex: 1 }}>
                        <PriceInp value={entry.price} onChange={(v) => updPyra(entry.id, "price", v)} ph={`${counterDirKr} 진입가 ($)`}
                          cp={counterPos ? getCp(counterPos.coin) : 0}
                          mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Inp value={entry.margin} onChange={(v) => updPyra(entry.id, "margin", v)} ph="투입금액 (USDT)" />
                        {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={(v) => updPyra(entry.id, "margin", v)} accentColor="#f59e0b" />}
                      </div>
                      {pyraEntries.length > 1 && (
                        <button onClick={() => rmPyra(entry.id)} style={S.rmSm}>×</button>
                      )}
                    </div>
                  ))}
                  <button onClick={addPyra} style={{ ...S.addBtn, borderColor: "#f59e0b33", color: "#f59e0b66" }}>+ 불타기 추가</button>

                  {/* Split helper */}
                  <button onClick={openPyraSplitHelper} style={{ ...S.splitToggle, borderColor: "#f59e0b33", color: "#f59e0b66" }}>
                    {pyraSplitMode ? "분할 매수 전략 접기 ▲" : "분할 매수 전략 ▼"}
                  </button>

                  {pyraSplitMode && (
                    <div style={{ ...S.splitPanel, borderColor: "#f59e0b22" }}>
                      <Fld label="총 투입금액 (USDT)">
                        <Inp value={pyraSplitTotal} onChange={setPyraSplitTotal} ph="300" />
                        {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={setPyraSplitTotal} accentColor="#f59e0b" />}
                      </Fld>
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>불타기 가격</div>
                        {pyraSplitPrices.map((sp, idx) => (
                          <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                            <div style={{ ...S.dcaNum, width: 20, height: 20, fontSize: 10, background: "#f59e0b15", borderColor: "#f59e0b33", color: "#f59e0b" }}>{idx + 1}</div>
                            <div style={{ flex: 1 }}>
                              <PriceInp value={sp} onChange={(v) => updPyraSplitPrice(idx, v)} ph={`가격 ${idx + 1}`}
                                cp={counterPos ? getCp(counterPos.coin) : 0}
                                mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                            </div>
                            {pyraSplitPrices.length > 2 && (
                              <button onClick={() => rmPyraSplitPrice(idx)} style={{ ...S.rmSm, width: 28, height: 32, fontSize: 14 }}>×</button>
                            )}
                          </div>
                        ))}
                        <button onClick={addPyraSplitPrice} style={{ ...S.addBtn, marginTop: 2, fontSize: 11, padding: "6px 0", borderColor: "#f59e0b33", color: "#f59e0b66" }}>+ 가격 추가</button>
                        <SplitAutoGen cp={counterPos ? getCp(counterPos.coin) : 0} isLong={counter.dir === "long"} onGenerate={setPyraSplitPrices} accentColor="#f59e0b" />
                      </div>

                      {calc?.pyraSplitResult && (
                        <>
                          <div style={{ height: 12 }} />
                          {calc.pyraSplitResult.marginInsufficient && (
                            <div style={{ ...S.warnBox, marginBottom: 8, fontSize: 11 }}>
                              ⚠ 사용 가능({fmt(calc.freeMargin)}) &lt; 총 투입({fmt(calc.pyraSplitResult.totalMargin)}) USDT
                            </div>
                          )}
                          <div style={S.splitGrid}>
                            {calc.pyraSplitResult.results.map((sr, i) => (
                              <div key={i} style={{
                                ...S.splitCard,
                                borderColor: i === 0 ? "#f59e0b44" : "#1e1e2e",
                              }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: i === 0 ? "#f59e0b" : "#94a3b8", fontFamily: "'DM Sans'" }}>
                                    {sr.name}
                                  </div>
                                  <div style={{ fontSize: 9, color: sr.desc.includes("⚠") ? "#f87171" : "#4b5563" }}>{sr.desc}</div>
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                  {sr.entries.map((e, j) => (
                                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", padding: "2px 0" }}>
                                      <span>${fmt(e.price, 0)}</span>
                                      <span>{fmt(e.margin, 0)} USDT</span>
                                    </div>
                                  ))}
                                </div>
                                <button onClick={() => {
                                  const newEntries = sr.entries.map((e) => ({
                                    id: uid(),
                                    price: String(e.price),
                                    margin: String(Math.round(e.margin * 100) / 100),
                                  }));
                                  setPyraEntries(newEntries);
                                }} style={{
                                  ...S.applyBtn,
                                  width: "100%", padding: "6px 0", textAlign: "center",
                                  borderColor: "#f59e0b33", background: "#f59e0b10", color: "#f59e0b",
                                }}>채우기</button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {pyraSubMode === "reverse" && (
                <div style={S.grid2}>
                  <Fld label={`${counterDirKr} 불타기 진입 예정가 ($)`}>
                    <PriceInp value={pyraRevPrice} onChange={setPyraRevPrice} ph="불타기 진입가"
                      cp={counterPos ? getCp(counterPos.coin) : 0}
                      mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                  </Fld>
                  <Fld label="목표 역전가 ($)">
                    <Inp value={pyraRevTarget} onChange={setPyraRevTarget} ph="이 가격에서 합산PnL=0" />
                  </Fld>
                </div>
              )}
            </>
          );
        })()}

        {/* ═══ ⑤-B PYRAMIDING RESULTS ═══ */}
        {calc?.pyraResult && calc.cp > 0 && (() => {
          const pr = calc.pyraResult;
          const hasExLiq = calc?.exLiq > 0;

          return (
            <>
              <div style={{ ...S.divider, background: "linear-gradient(90deg, transparent, #f59e0b22, transparent)" }} />
              <Sec label="불타기 시뮬레이션 결과" pyra />

              {/* Warnings */}
              {pr.warnings.map((w, i) => (
                <div key={i} style={S.warnBox}>⚠ {w.message}</div>
              ))}

              {/* 역전가 프로그레스 */}
              {pr.reversalPrice && (
                <div style={{ ...S.card, borderColor: "#f59e0b33", marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#f59e0b", letterSpacing: 2, fontFamily: "'DM Sans'" }}>
                      본전 회복 가격
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                      ${fmt(pr.reversalPrice)}
                    </div>
                  </div>
                  <div style={{ height: 8, background: "#1e1e2e", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", borderRadius: 4, transition: "width 0.3s",
                      width: `${Math.max((pr.reversalProgress || 0) * 100, 0)}%`,
                      background: (pr.reversalProgress || 0) >= 1 ? "#34d399" : "linear-gradient(90deg, #f59e0b, #34d399)",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 4, color: "#4b5563" }}>
                    <span>현재가서 {fmtS(pr.reversalDist)}%</span>
                    <span style={{ color: (pr.reversalProgress || 0) >= 1 ? "#34d399" : "#f59e0b" }}>
                      {(pr.reversalProgress || 0) >= 1 ? "🎉 역전 달성!" : `${fmt((pr.reversalProgress || 0) * 100, 0)}%`}
                    </span>
                  </div>
                </div>
              )}

              {/* 청산 시나리오 비교 */}
              {pr.closeScenarios && (
                <div style={{ ...S.card, borderColor: "#1e1e2e", marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                    지금 청산하면?
                  </div>
                  {[pr.closeScenarios.both, pr.closeScenarios.counterOnly, pr.closeScenarios.lockedOnly].map((sc, i) => (
                    <div key={i} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "10px 12px", marginBottom: 4, borderRadius: 8,
                      background: i === 0 ? (sc.net >= 0 ? "#34d39908" : "#f8717108") : "#0a0a14",
                      border: `1px solid ${i === 0 ? (sc.net >= 0 ? "#34d39922" : "#f8717122") : "#1e1e2e"}`,
                    }}>
                      <div>
                        <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: i === 0 ? 600 : 400 }}>{sc.label}</div>
                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>수수료 -{fmt(sc.fee)}</div>
                      </div>
                      <div style={{
                        fontSize: i === 0 ? 15 : 13, fontWeight: 700,
                        color: sc.net >= 0 ? "#34d399" : "#f87171",
                        fontFamily: "'IBM Plex Mono'",
                      }}>
                        {fmtS(sc.net)} USDT
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 합산 PnL + 청산가 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <HLCard label="현재 합산 PnL"
                  value={`${fmtS(pr.combinedPnL)} USDT`}
                  delta={`물린 ${fmtS(pr.locked?.pnl || 0)} / 반대 ${fmtS(pr.combinedPnL - (pr.locked?.pnl || 0))}`}
                  deltaColor={pr.combinedPnL >= 0 ? "#34d399" : "#f87171"} />
                {hasExLiq && pr.newLiqPrice != null ? (
                  <HLCard label="새 청산가 (추정)"
                    value={`$${fmt(pr.newLiqPrice)}`}
                    delta={pr.newLiqDist != null ? `여유 ${fmt(Math.abs(pr.newLiqDist))}%${pr.liqBefore ? ` (기존 $${fmt(pr.liqBefore)})` : ""}` : null}
                    deltaColor={Math.abs(pr.newLiqDist || 0) < 15 ? "#f87171" : "#34d399"} />
                ) : (
                  <HLCard label="기존 청산가"
                    value={pr.liqBefore ? `$${fmt(pr.liqBefore)}` : "—"}
                    delta={pr.liqDistBefore != null ? `${fmt(Math.abs(pr.liqDistBefore))}% 여유` : null}
                    deltaColor="#6b7280" />
                )}
              </div>

              {/* Stage-by-stage table */}
              {pr.stages.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 8 }}>
                    진입 단계별 역전가 변화
                  </div>
                  <div style={S.tblWrap}>
                    <table style={S.tbl}>
                      <thead>
                        <tr>
                          <TH>단계</TH><TH>마진</TH><TH>누적</TH>
                          <TH>역전가</TH>
                          {hasExLiq && <><TH>청산가</TH><TH>여유</TH></>}
                        </tr>
                      </thead>
                      <tbody>
                        {pr.stages.map((st, i) => (
                          <tr key={i} style={i === pr.stages.length - 1 ? { background: "#0c0c18" } : {}}>
                            <TD c={i === pr.stages.length - 1 ? "#f59e0b" : "#94a3b8"}>{st.label}</TD>
                            <TD>{fmt(st.margin, 0)}</TD>
                            <TD c="#e2e8f0">{fmt(st.cumMargin, 0)}</TD>
                            <TD c="#f59e0b">{st.reversalPrice ? `$${fmt(st.reversalPrice)}` : "—"}</TD>
                            {hasExLiq && (
                              <>
                                <TD>{st.liqPrice ? `$${fmt(st.liqPrice)}` : "—"}</TD>
                                <TD c={st.liqDist != null && Math.abs(st.liqDist) < 15 ? "#f87171" : "#34d399"}>
                                  {st.liqDist != null ? `${fmt(Math.abs(st.liqDist))}%` : "—"}
                                </TD>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Visual: reversal price approaching */}
                  {pr.stages.length > 1 && calc.cp > 0 && (() => {
                    const validStages = pr.stages.filter((s) => s.reversalPrice != null);
                    if (validStages.length < 2) return null;
                    const allPrices = [calc.cp, ...validStages.map((s) => s.reversalPrice)];
                    if (pr.liqBefore) allPrices.push(pr.liqBefore);
                    const minP = Math.min(...allPrices) * 0.98;
                    const maxP = Math.max(...allPrices) * 1.02;
                    const range = maxP - minP;
                    if (range <= 0) return null;
                    const pctOf = (p) => ((p - minP) / range) * 100;

                    return (
                      <div style={{ padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginTop: 8, marginBottom: 12 }}>
                        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 12 }}>역전가 접근 시각화</div>
                        <div style={{ position: "relative", height: validStages.length * 28 + 20 }}>
                          {/* Current price line */}
                          <div style={{
                            position: "absolute", left: `${pctOf(calc.cp)}%`, top: 0, bottom: 0,
                            width: 1, background: "#4b5563", zIndex: 1,
                          }} />
                          <div style={{
                            position: "absolute", left: `${pctOf(calc.cp)}%`, top: -2,
                            transform: "translateX(-50%)", fontSize: 9, color: "#6b7280", whiteSpace: "nowrap",
                          }}>현재가</div>

                          {/* Liq price line */}
                          {pr.liqBefore && (
                            <>
                              <div style={{
                                position: "absolute", left: `${pctOf(pr.liqBefore)}%`, top: 0, bottom: 0,
                                width: 1, background: "#f8717144", zIndex: 1,
                              }} />
                              <div style={{
                                position: "absolute", left: `${pctOf(pr.liqBefore)}%`, bottom: -2,
                                transform: "translateX(-50%)", fontSize: 8, color: "#f8717188", whiteSpace: "nowrap",
                              }}>청산</div>
                            </>
                          )}

                          {/* Stage bars */}
                          {validStages.map((st, i) => {
                            const left = Math.min(pctOf(calc.cp), pctOf(st.reversalPrice));
                            const right = Math.max(pctOf(calc.cp), pctOf(st.reversalPrice));
                            return (
                              <div key={i} style={{
                                position: "absolute", top: 14 + i * 28, left: `${left}%`, width: `${right - left}%`,
                                height: 16, borderRadius: 3,
                                background: `linear-gradient(90deg, #f59e0b22, #f59e0b${Math.min(20 + i * 15, 60).toString(16)})`,
                                border: "1px solid #f59e0b33",
                                display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 4,
                              }}>
                                <span style={{ fontSize: 9, color: "#f59e0b", whiteSpace: "nowrap" }}>
                                  {st.label}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              {/* Simultaneous close scenarios table */}
              {pr.scenarios.length > 0 && (
                <div style={S.exitBox}>
                  <div style={{ ...S.exitTitle, color: "#f59e0b" }}>동시 청산 시나리오</div>
                  <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 12 }}>
                    다양한 가격에서 양 포지션 동시 청산 시 결과
                  </div>
                  <div style={S.tblWrap}>
                    <table style={S.tbl}>
                      <thead>
                        <tr>
                          <TH>가격</TH>
                          <TH>물린 PnL</TH>
                          <TH>반대 PnL</TH>
                          <TH>수수료</TH>
                          <TH>순손익</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {pr.scenarios.map((sc, i) => {
                          const isReversal = sc.label === "역전가";
                          const isCurrent = sc.label === "현재가";
                          return (
                            <tr key={i} style={{
                              background: isReversal ? "#f59e0b08" : isCurrent ? "#0c0c18" : "transparent",
                            }}>
                              <TD c={isReversal ? "#f59e0b" : isCurrent ? "#e2e8f0" : "#94a3b8"}>
                                <div>{sc.label}</div>
                                <div style={{ fontSize: 10, color: "#4b5563" }}>${fmt(sc.price)}</div>
                              </TD>
                              <TD c={sc.lockedPnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(sc.lockedPnL, 0)}</TD>
                              <TD c={sc.counterPnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(sc.counterPnL, 0)}</TD>
                              <TD c="#6b7280">-{fmt(sc.fee, 0)}</TD>
                              <TD c={sc.net >= 0 ? "#34d399" : "#f87171"} bold>
                                {fmtS(sc.net, 0)}
                              </TD>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Info items */}
              {pr.infos.length > 0 && (
                <div style={S.detBox}>
                  <div style={S.detTitle}>참고</div>
                  {pr.infos.map((info, i) => (
                    <SL key={i} label="ℹ" value={info} />
                  ))}
                </div>
              )}

              {/* 불타기 vs 물타기 비교 */}
              {pr.dcaComparison && pr.pyraList.length > 0 && (
                <div style={{ ...S.card, borderColor: "#6b728033", marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                    같은 금액({fmt(pr.addTotalMargin, 0)} USDT) 투입 시 비교
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 0, fontSize: 12 }}>
                    {/* header */}
                    <div style={{ padding: "6px 8px", color: "#4b5563", fontSize: 10 }}></div>
                    <div style={{ padding: "6px 8px", color: "#f59e0b", fontSize: 10, fontWeight: 700, textAlign: "center" }}>🔥 불타기</div>
                    <div style={{ padding: "6px 8px", color: "#0ea5e9", fontSize: 10, fontWeight: 700, textAlign: "center" }}>💧 물타기</div>
                    {/* 본전/역전 가격 */}
                    <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #1e1e2e" }}>본전/역전가</div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #1e1e2e", color: "#f59e0b", fontWeight: 600 }}>
                      {pr.dcaComparison.pyraReversal ? `$${fmt(pr.dcaComparison.pyraReversal)}` : "—"}
                    </div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #1e1e2e", color: "#0ea5e9", fontWeight: 600 }}>
                      ${fmt(pr.dcaComparison.dcaBreakeven)}
                    </div>
                    {/* 청산가 */}
                    {hasExLiq && (<>
                      <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #0e0e18" }}>청산가</div>
                      <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", color: "#94a3b8" }}>
                        {pr.dcaComparison.pyraLiq ? `$${fmt(pr.dcaComparison.pyraLiq)}` : "—"}
                      </div>
                      <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", color: "#94a3b8" }}>
                        {pr.dcaComparison.dcaLiq ? `$${fmt(pr.dcaComparison.dcaLiq)}` : "—"}
                      </div>
                    </>)}
                    {/* 특징 */}
                    <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #0e0e18" }}>특징</div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", fontSize: 10, color: "#4b5563" }}>
                      양방향 헷지 유지
                    </div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", fontSize: 10, color: "#4b5563" }}>
                      평단 낮추기 집중
                    </div>
                  </div>
                </div>
              )}

              {/* 불타기 적용 원클릭 */}
              {pr.pyraList.length > 0 && (
                <button onClick={() => {
                  // counter 포지션 업데이트
                  const newAvg = pr.counter.avg;
                  const newMargin = pr.counter.margin;
                  updPos(pyraCounterId, "entryPrice", String(Math.round(newAvg * 100) / 100));
                  updPos(pyraCounterId, "margin", String(Math.round(newMargin * 100) / 100));
                  // 진입 목록 초기화
                  setPyraEntries([mkPyra()]);
                }} style={{
                  width: "100%", padding: "14px 0", marginTop: 12, borderRadius: 10,
                  border: "1px solid #f59e0b44",
                  background: "#f59e0b10",
                  color: "#f59e0b",
                  fontSize: 14, fontWeight: 700, cursor: "pointer",
                  fontFamily: "'DM Sans'", letterSpacing: 0.5,
                  transition: "all 0.15s",
                }}>
                  ⚡ 불타기 적용 — 평단 ${fmt(pr.counter.avg)} · 마진 {fmt(pr.counter.margin, 0)}
                </button>
              )}
            </>
          );
        })()}

        {/* ═══ ⑤-B PYRAMIDING REVERSE RESULT ═══ */}
        {calc?.pyraRevResult && (() => {
          const prv = calc.pyraRevResult;
          if (prv.alreadyReversed) return (
            <div style={{ ...S.warnBox, borderColor: "#34d39933", color: "#34d399", background: "#34d39908" }}>
              ✓ 현재 상태에서 이미 해당 가격에 도달하면 손익이 역전됩니다. 추가 불타기 불필요.
            </div>
          );
          if (prv.impossible) return (
            <div style={S.warnBox}>⚠ 이 가격 조합으로는 역전가에 도달할 수 없습니다.</div>
          );
          return (
            <>
              <div style={{ ...S.divider, background: "linear-gradient(90deg, transparent, #f59e0b22, transparent)" }} />
              <Sec label="역계산 결과" pyra />
              <div style={{
                ...S.revHL,
                borderColor: prv.marginInsufficient ? "#f8717144" : "#f59e0b44",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>필요 추가 마진</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: prv.marginInsufficient ? "#f87171" : "#f59e0b" }}>
                  {fmt(prv.neededMargin)} USDT
                </div>
                {prv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>
                    ⚠ 여유 마진 부족 — {fmt(prv.neededMargin - (calc.freeMargin || 0))} USDT 모자람
                  </div>
                )}
                {prv.feasible && (
                  <div style={{ fontSize: 12, color: "#34d399", marginTop: 8 }}>✓ 여유 마진 내 가능</div>
                )}
              </div>
              <div style={S.detBox}>
                <div style={S.detTitle}>DETAILS</div>
                <SL label="반대 포지션 새 평단" value={prv.counterAvg ? `$${fmt(prv.counterAvg)}` : "—"} />
                <SL label="반대 포지션 총 마진" value={prv.counterMargin ? `${fmt(prv.counterMargin)} USDT` : "—"} />
                {prv.liqPrice != null && (
                  <SL label="새 청산가 (추정)" value={`$${fmt(prv.liqPrice)}`}
                    warn={prv.liqDist != null && Math.abs(prv.liqDist) < 15} />
                )}
                {prv.liqDist != null && (
                  <SL label="청산 여유" value={`${fmt(Math.abs(prv.liqDist))}%`}
                    warn={Math.abs(prv.liqDist) < 15} />
                )}
              </div>
            </>
          );
        })()}

        {/* ⑤ RESULTS — Simulation */}
        {calc?.dcaResult && (() => {
          const r = calc.dcaResult;
          const isLong = calc.sel.dir === "long";
          return <ResultBlock r={r} isLong={isLong} cp={calc.cp} mode="sim" hasExLiq={calc?.exLiq > 0} />;
        })()}

        {/* ⑤ RESULTS — Reverse */}
        {calc?.revResult && (() => {
          const rv = calc.revResult;
          if (rv.impossible) return (
            <div style={S.warnBox}>
              ⚠ 이 진입가로는 목표 평단에 도달할 수 없습니다.
              {calc.sel.dir === "long"
                ? " 롱 물타기는 현재 평단보다 낮은 가격에 진입해야 평단이 내려갑니다."
                : " 숏 물타기는 현재 평단보다 높은 가격에 진입해야 평단이 올라갑니다."}
            </div>
          );
          const isLong = calc.sel.dir === "long";
          return (
            <>
              <div style={S.divider} />
              <Sec label="역계산 결과" />
              <div style={{
                ...S.revHL,
                borderColor: rv.marginInsufficient ? "#f8717144" : "#0ea5e944",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>필요 추가 마진</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: rv.marginInsufficient ? "#f87171" : "#0ea5e9" }}>
                  {fmt(rv.requiredMargin)} USDT
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                  투입 필요: {fmt(rv.requiredInputMargin)} USDT <span style={{ color: "#4b5563" }}>(수수료 {fmt(rv.revFeeDeduct)} 포함)</span>
                </div>
                {rv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>
                    ⚠ 여유 마진 부족 — {fmt(rv.requiredMargin - calc.freeMargin)} USDT 모자람
                    {rv.maxReachableAvg != null && (
                      <div style={{ marginTop: 4, color: "#f59e0b" }}>
                        현재 여유 마진으로 도달 가능한 최대 평단: ${fmt(rv.maxReachableAvg)}
                      </div>
                    )}
                  </div>
                )}
                {!rv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#34d399", marginTop: 8 }}>✓ 여유 마진 내 가능</div>
                )}
              </div>
              <ResultBlock r={rv} isLong={isLong} cp={calc.cp} mode="reverse" hasExLiq={calc?.exLiq > 0} />
            </>
          );
        })()}

        {/* ⑤ RESULTS — Close (손절) */}
        {calc?.closeResult && (() => {
          const cr = calc.closeResult;
          const isLong = calc.sel.dir === "long";
          const hasExLiq = calc?.exLiq > 0;
          return (
            <>
              <div style={S.divider} />
              <Sec label="손절 결과" />

              {/* Realized PnL highlight */}
              <div style={{
                ...S.revHL,
                borderColor: cr.realizedPnL >= 0 ? "#34d39944" : "#f8717144",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>실현 손익</div>
                <div style={{
                  fontSize: 28, fontWeight: 700,
                  color: cr.realizedPnL >= 0 ? "#34d399" : "#f87171",
                }}>
                  {fmtS(cr.realizedPnL)} USDT
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                  마진 {fmt(cr.closedMargin)} 해제 · 수수료 {fmt(cr.closeFee)} USDT
                </div>
              </div>

              {/* Before / After comparison */}
              {calc.cp > 0 && (
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <TH />
                        <TH>지갑 잔고</TH><TH>마진</TH>
                        <TH>사용 가능</TH>
                        {hasExLiq && <><TH>청산가</TH><TH>청산여유</TH></>}
                        <TH>미실현 PnL (ROE)</TH>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <TD c="#6b7280">Before</TD>
                        <TD>{fmt(calc.wb)}</TD>
                        <TD>{fmt(calc.sel.mg)}</TD>
                        <TD>{fmt(calc.freeMargin)}</TD>
                        {hasExLiq && (
                          <>
                            <TD>{cr.liqBefore ? `$${fmt(cr.liqBefore)}` : "—"}</TD>
                            <TD>{cr.liqDistBefore != null ? `${fmt(Math.abs(cr.liqDistBefore))}%` : "—"}</TD>
                          </>
                        )}
                        <TD c={calc.sel.pnl >= 0 ? "#34d399" : "#f87171"}>
                          {fmtS(calc.sel.pnl)} ({fmtS(calc.sel.roe)}%)
                        </TD>
                      </tr>
                      <tr style={{ background: "#0c0c18" }}>
                        <TD c="#e2e8f0" bold>After</TD>
                        <TD c="#e2e8f0">{fmt(cr.newWallet)}</TD>
                        <TD c="#e2e8f0">{fmt(cr.remaining.margin)}</TD>
                        <TD c={cr.remFreeMargin > 0 ? "#34d399" : "#f87171"} bold>
                          {fmt(cr.remFreeMargin)}
                        </TD>
                        {hasExLiq && (
                          <>
                            <TD c={cr.remLiq != null ? "#34d399" : "#6b7280"}>
                              {cr.remLiq != null ? `$${fmt(cr.remLiq)}` : "—"}
                            </TD>
                            <TD c="#34d399">
                              {cr.remLiqDist != null ? `${fmt(Math.abs(cr.remLiqDist))}%` : "—"}
                            </TD>
                          </>
                        )}
                        <TD c={cr.remaining.pnl >= 0 ? "#34d399" : "#f87171"} bold>
                          {cr.remaining.qty > 0
                            ? `${fmtS(cr.remaining.pnl)} (${fmtS(cr.remaining.roe)}%)`
                            : "포지션 청산됨"}
                        </TD>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* Key metrics */}
              <div style={S.detBox}>
                <div style={S.detTitle}>DETAILS</div>
                <SL label="손절 비율" value={`${cr.ratio * 100}%`} />
                <SL label="손절 가격" value={`$${fmt(cr.closePrice)}`} />
                <SL label="실현 손익" value={`${fmtS(cr.realizedPnL)} USDT`} warn={cr.realizedPnL < 0} />
                <SL label="종료 수수료" value={`${fmt(cr.closeFee)} USDT`} />
                <SL label="새 지갑 잔고" value={`${fmt(cr.newWallet)} USDT`} />
                <SL label="손절 후 사용 가능" value={`${fmt(cr.remFreeMargin)} USDT`} />
              </div>

              {/* Close + DCA scenario */}
              {cr.closeAndDCA && cr.remaining.qty > 0 && (
                <div style={S.cdBox}>
                  <div style={S.cdTitle}>손절 후 물타기 시나리오</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
                    남은 포지션에 확보된 {fmt(cr.remFreeMargin, 0)} USDT로
                    ${fmt(cr.closeAndDCA.dcaPrice)}에 물타기 시
                  </div>
                  <div style={S.hlGrid}>
                    <HLCard label="새 평단가" value={`$${fmt(cr.closeAndDCA.newAvg)}`}
                      delta={`기존 대비 ${fmtS(pct(cr.closeAndDCA.newAvg - calc.sel.ep, calc.sel.ep))}%`}
                      deltaColor={(isLong && cr.closeAndDCA.newAvg < calc.sel.ep) || (!isLong && cr.closeAndDCA.newAvg > calc.sel.ep) ? "#34d399" : "#f87171"} />
                    <HLCard label="탈출가" value={`$${fmt(cr.closeAndDCA.breakeven)}`}
                      delta={cr.closeAndDCA.liq != null ? `청산가 $${fmt(cr.closeAndDCA.liq)}` : ""}
                      deltaColor="#f59e0b" />
                  </div>
                  <div style={{ fontSize: 10, color: "#4b5563", marginTop: 4 }}>
                    * 시뮬레이션 모드의 첫 번째 물타기 진입가 기준
                  </div>
                </div>
              )}

              {cr.remaining.qty === 0 && (
                <div style={{ ...S.warnBox, borderColor: "#f59e0b33", color: "#f59e0b", background: "#f59e0b08" }}>
                  100% 손절 시 포지션이 완전히 청산됩니다. 실현 손실이 지갑 잔고에서 차감됩니다.
                </div>
              )}
            </>
          );
        })()}

        <div style={S.footer}>
          교차 마진 · 거래소 청산가 기반 추정 · 수수료 왕복 · 펀딩비 미반영
        </div>

        </>)}

        {/* ══════ HEDGE CYCLE TAB ══════ */}
        {appTab === "hedge" && (<>

          {/* HC ① 계좌 & 시장 (공유) */}
          <Sec label="계좌 & 시장" />
          <div style={S.grid2}>
            <Fld label="지갑 총 잔고 (USDT)">
              <Inp value={wallet} onChange={setWallet} ph="10000" />
            </Fld>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Sans'" }}>
                  현재가 ($) — {primaryCoin}/USDT
                </div>
                <button onClick={() => {
                  if (priceMode === "live") { setPriceMode("manual"); }
                  else { setPriceMode("live"); setFetchError(false); }
                }} style={{
                  ...S.miniBtn, fontSize: 9, padding: "2px 8px",
                  color: priceMode === "live" ? "#34d399" : "#6b7280",
                  borderColor: priceMode === "live" ? "#34d39933" : "#1e1e2e",
                }}>
                  {priceMode === "live" ? "✎ 수동" : "↻ 실시간"}
                </button>
              </div>
              <input type="number" value={coinPrices[primaryCoin] || ""} placeholder={`${primaryCoin}/USDT`}
                readOnly={priceMode === "live"} onChange={(e) => setCp(primaryCoin, e.target.value)}
                style={{ ...S.inp, flex: 1, borderColor: priceMode === "live" ? "#34d39944" : "#1e1e2e",
                  background: priceMode === "live" ? "#060d08" : "#0a0a12",
                  cursor: priceMode === "live" ? "default" : "text", transition: "color 0.3s" }} />
            </div>
          </div>

          {/* HC ② 전략 파라미터 */}
          <Sec label="전략 파라미터" />
          <div style={S.grid3}>
            <Fld label="기본 마진 (USDT)">
              <Inp value={hcMargin} onChange={setHcMargin} ph="1000" />
            </Fld>
            <Fld label="레버리지">
              <Inp value={hcLeverage} onChange={setHcLeverage} ph="100" />
            </Fld>
            <Fld label="익절 ROE (%)">
              <Inp value={hcTakeROE} onChange={setHcTakeROE} ph="40" />
            </Fld>
          </div>
          <div style={{ ...S.grid3, marginTop: 8 }}>
            <Fld label="손절 비율 (%)">
              <Inp value={hcCutRatio} onChange={setHcCutRatio} ph="50" />
            </Fld>
            <Fld label="복구 ROE (%)">
              <Inp value={hcRecoveryROE} onChange={setHcRecoveryROE} ph="0" />
            </Fld>
            <Fld label="킬 스위치 (%)">
              <Inp value={hcKillPct} onChange={setHcKillPct} ph="15" />
            </Fld>
            <Fld label="수수료율 (%)">
              <Inp value={feeRate} onChange={setFeeRate} ph="0.04" />
            </Fld>
          </div>

          {/* HC ③ 현재 포지션 입력 */}
          <Sec label="현재 포지션" />
          <div style={S.grid2}>
            <div style={{ ...S.card, borderColor: "#34d39933", background: "#060d08" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#34d399", marginBottom: 8, fontFamily: "'DM Sans'" }}>LONG</div>
              <Fld label="진입가 ($)">
                <Inp value={hcLongEntry} onChange={setHcLongEntry} ph="진입 평단가" />
              </Fld>
              <div style={{ marginTop: 6 }}>
                <Fld label="현재 마진 (USDT)">
                  <Inp value={hcLongMargin} onChange={setHcLongMargin} ph={hcMargin || "1000"} />
                </Fld>
              </div>
              {hcCalc && n(hcLongEntry) > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: hcCalc.longROE >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                  PnL: {fmtS(hcCalc.longPnL)} ({fmtS(hcCalc.longROE)}%)
                </div>
              )}
            </div>
            <div style={{ ...S.card, borderColor: "#f8717133", background: "#0d0608" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#f87171", marginBottom: 8, fontFamily: "'DM Sans'" }}>SHORT</div>
              <Fld label="진입가 ($)">
                <Inp value={hcShortEntry} onChange={setHcShortEntry} ph="진입 평단가" />
              </Fld>
              <div style={{ marginTop: 6 }}>
                <Fld label="현재 마진 (USDT)">
                  <Inp value={hcShortMargin} onChange={setHcShortMargin} ph={hcMargin || "1000"} />
                </Fld>
              </div>
              {hcCalc && n(hcShortEntry) > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: hcCalc.shortROE >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                  PnL: {fmtS(hcCalc.shortPnL)} ({fmtS(hcCalc.shortROE)}%)
                </div>
              )}
            </div>
          </div>

          {/* HC ④ 상태 대시보드 */}
          {hcCalc && getCp(primaryCoin) > 0 && (<>
            <Sec label="상태 대시보드" />

            {/* 현재 상태 표시 */}
            <div style={{
              padding: 20, borderRadius: 12, textAlign: "center", marginBottom: 12,
              background: hcCalc.state === 1 ? "#34d39908" : hcCalc.state === 3 ? "#0ea5e908" : "#f59e0b08",
              border: `1px solid ${hcCalc.state === 1 ? "#34d39933" : hcCalc.state === 3 ? "#0ea5e933" : "#f59e0b33"}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans'", marginBottom: 6,
                color: hcCalc.state === 1 ? "#34d399" : hcCalc.state === 3 ? "#0ea5e9" : "#f59e0b" }}>
                {hcCalc.state === 1 ? "🟢 상태 1 — Balanced (1:1)" :
                 hcCalc.state === 3 ? "🔵 상태 3 — Recovery 가능" :
                 "🟡 상태 2 — Imbalanced"}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>
                롱 {fmt(hcCalc.longMg, 0)} : 숏 {fmt(hcCalc.shortMg, 0)}
                {!hcCalc.isBalanced && ` (${fmt(hcCalc.ratio, 1)}:1)`}
              </div>
            </div>

            {/* 트리거 프로그레스 */}
            {hcCalc.state === 1 && (
              <div style={{ ...S.card, borderColor: "#1e1e2e" }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  익절 트리거 대기
                </div>
                {hcCalc.winner && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: "#94a3b8" }}>
                        {hcCalc.winner === "long" ? "롱" : "숏"} ROE: {fmtS(hcCalc.winnerROE)}%
                      </span>
                      <span style={{ color: "#0ea5e9" }}>목표: +{hcCalc.takeROE}%</span>
                    </div>
                    <div style={{ height: 8, background: "#1e1e2e", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 4, transition: "width 0.3s",
                        width: `${Math.max(hcCalc.winnerProgress * 100, 0)}%`,
                        background: hcCalc.winnerProgress >= 1 ? "#34d399" : "linear-gradient(90deg, #0ea5e9, #34d399)",
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#4b5563", marginTop: 6 }}>
                      {hcCalc.winnerProgress >= 1 ? (
                        <span style={{ color: "#34d399", fontWeight: 600 }}>🚨 트리거 도달! 아래 액션을 실행하세요</span>
                      ) : (
                        <>
                          트리거 가격: <span style={{ color: "#e2e8f0" }}>
                            ${fmt(hcCalc.winner === "long" ? hcCalc.longTriggerPrice : hcCalc.shortTriggerPrice)}
                          </span>
                          <span style={{ color: "#4b5563", marginLeft: 6 }}>
                            ({fmtS(((hcCalc.winner === "long" ? hcCalc.longTriggerPrice : hcCalc.shortTriggerPrice) - getCp(primaryCoin)) / getCp(primaryCoin) * 100)}%)
                          </span>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 복구 프로그레스 (state 2) */}
            {hcCalc.state === 2 && hcCalc.recoveryPrice && (
              <div style={{ ...S.card, borderColor: "#f59e0b33" }}>
                <div style={{ fontSize: 10, color: "#f59e0b", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  복구 대기 — {hcCalc.loser === "long" ? "롱" : "숏"} 본전 복귀 중
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: "#94a3b8" }}>
                    {hcCalc.loser === "long" ? "롱" : "숏"} ROE: {fmtS(hcCalc.loserROE)}%
                  </span>
                  <span style={{ color: "#0ea5e9" }}>목표: {hcCalc.recovROE}%</span>
                </div>
                <div style={{ fontSize: 11, color: "#4b5563", marginTop: 6 }}>
                  복구 가격: <span style={{ color: "#e2e8f0" }}>${fmt(hcCalc.recoveryPrice)}</span>
                  <span style={{ color: "#4b5563", marginLeft: 6 }}>
                    ({fmtS(((hcCalc.recoveryPrice) - getCp(primaryCoin)) / getCp(primaryCoin) * 100)}%)
                  </span>
                </div>
              </div>
            )}

            {/* 액션 체크리스트 */}
            {hcCalc.actions.length > 0 && (
              <div style={{ ...S.card, borderColor: hcCalc.state === 3 ? "#0ea5e933" : "#34d39933" }}>
                <div style={{ fontSize: 10, color: hcCalc.state === 3 ? "#0ea5e9" : "#34d399", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  {hcCalc.state === 3 ? "복구 액션" : "실행할 액션"}
                </div>
                {hcCalc.actions.map((act, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 12px", marginBottom: 4, borderRadius: 8,
                    background: act.type === "profit" ? "#34d39908" : act.type === "loss" ? "#f8717108" : act.type === "recovery" ? "#0ea5e908" : "#0a0a14",
                    border: `1px solid ${act.type === "profit" ? "#34d39922" : act.type === "loss" ? "#f8717122" : act.type === "recovery" ? "#0ea5e922" : "#1e1e2e"}`,
                  }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 500 }}>{act.label}</div>
                      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{act.detail}</div>
                    </div>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      color: act.type === "profit" ? "#34d399" : act.type === "loss" ? "#f87171" : "#0ea5e9",
                    }}>
                      {act.type === "profit" ? "익절" : act.type === "loss" ? "손절" : act.type === "entry" ? "진입" : "복구"}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 손익 시뮬레이션 테이블 */}
            {hcCalc.cycleProfit && (
              <div style={{ ...S.card, borderColor: "#0ea5e922" }}>
                <div style={{ fontSize: 10, color: "#0ea5e9", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  사이클 실행 시 예상 손익
                </div>
                {[
                  { label: `${hcCalc.winner === "long" ? "롱" : "숏"} 익절 수익`, value: hcCalc.cycleProfit.winProfit, color: "#34d399", prefix: "+" },
                  { label: "  └ 청산 수수료", value: -hcCalc.cycleProfit.winCloseFee, color: "#f87171", prefix: "" },
                  { label: `${hcCalc.winner === "long" ? "롱" : "숏"} 재진입 수수료`, value: -hcCalc.cycleProfit.reentryFee, color: "#f87171", prefix: "" },
                  { label: `${hcCalc.loser === "long" ? "롱" : "숏"} ${n(hcCutRatio)}% 손절`, value: hcCalc.cycleProfit.loserCutPnL, color: "#f87171", prefix: "" },
                  { label: "  └ 청산 수수료", value: -hcCalc.cycleProfit.loserCutFee, color: "#f87171", prefix: "" },
                ].map((row, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", padding: "4px 0",
                    borderBottom: i < 4 ? "1px solid #0e0e18" : "none", fontSize: 12,
                  }}>
                    <span style={{ color: "#94a3b8" }}>{row.label}</span>
                    <span style={{ color: row.color, fontWeight: 500 }}>
                      {row.prefix}{fmt(row.value)} USDT
                    </span>
                  </div>
                ))}
                <div style={{
                  display: "flex", justifyContent: "space-between", padding: "8px 0 4px",
                  borderTop: "1px solid #1e1e2e", marginTop: 4, fontSize: 13, fontWeight: 700,
                }}>
                  <span style={{ color: "#e2e8f0" }}>순수익</span>
                  <span style={{ color: hcCalc.cycleProfit.netProfit >= 0 ? "#34d399" : "#f87171" }}>
                    {fmtS(hcCalc.cycleProfit.netProfit)} USDT
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 11 }}>
                  <span style={{ color: "#4b5563" }}>발생 거래량</span>
                  <span style={{ color: "#6b7280" }}>{fmt(hcCalc.cycleProfit.totalVolume, 0)} USDT</span>
                </div>
              </div>
            )}

            {/* 알림 가격 가이드 */}
            {hcCalc.alertPrices.length > 0 && (
              <div style={{ ...S.card, borderColor: "#1e1e2e" }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  📌 거래소 알림 설정 가이드
                </div>
                {hcCalc.alertPrices.map((ap, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                    background: "#0a0a14", border: "1px solid #1e1e2e",
                  }}>
                    <div>
                      <div style={{ fontSize: 11, color: ap.color, fontWeight: 600 }}>{ap.label}</div>
                      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                        현재가 대비 {fmtS(((ap.price - getCp(primaryCoin)) / getCp(primaryCoin)) * 100)}%
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", fontFamily: "'IBM Plex Mono'" }}>
                        ${fmt(ap.price)}
                      </span>
                      <button onClick={() => {
                        try { navigator.clipboard.writeText(String(ap.price.toFixed(2))); } catch (e) {}
                      }} style={{
                        ...S.miniBtn, fontSize: 10, padding: "3px 6px",
                        color: "#4b5563", borderColor: "#1e1e2e",
                      }} title="복사">📋</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 사이클 실행 버튼 */}
            {hcCalc.actions.length > 0 && (
              <button onClick={() => {
                const cp = getCp(primaryCoin);
                if (!cp) return;
                const profit = hcCalc.cycleProfit ? hcCalc.cycleProfit.netProfit : 0;

                if (hcCalc.state === 1 || hcCalc.state === 2) {
                  // State 1→2 또는 State 2→2 (원웨이): 익절+재진입+손절
                  // Winner: 재진입이므로 진입가 = 현재가
                  if (hcCalc.winner === "long") {
                    setHcLongEntry(String(cp));
                    setHcLongMargin(String(hcCalc.baseMg));
                    // Loser(숏): 마진 cutRatio만큼 축소, 진입가 유지
                    setHcShortMargin(String(Math.round(hcCalc.shortMg * (1 - hcCalc.cutRatio) * 100) / 100));
                  } else {
                    setHcShortEntry(String(cp));
                    setHcShortMargin(String(hcCalc.baseMg));
                    setHcLongMargin(String(Math.round(hcCalc.longMg * (1 - hcCalc.cutRatio) * 100) / 100));
                  }
                  // 지갑 잔고 업데이트 (수익 반영)
                  setWallet(String(Math.round((n(wallet) + profit) * 100) / 100));
                  setHcCycles((prev) => [...prev, {
                    profit: Math.round(profit * 100) / 100,
                    note: hcCalc.state === 1 ? "횡보 익절" : "원웨이 익절",
                    ts: Date.now(),
                  }]);
                } else if (hcCalc.state === 3) {
                  // State 3→1: 복구 — loser에 마진 채우기
                  const loserEp = hcCalc.loser === "long" ? hcCalc.longEp : hcCalc.shortEp;
                  const loserMg = hcCalc.loser === "long" ? hcCalc.longMg : hcCalc.shortMg;
                  const fillMg = hcCalc.baseMg - loserMg;
                  // 새 평단 = 조화평균
                  const oldNotional = loserMg * hcCalc.lev;
                  const addNotional = fillMg * hcCalc.lev;
                  const oldQty = loserEp > 0 ? oldNotional / loserEp : 0;
                  const addQty = cp > 0 ? addNotional / cp : 0;
                  const newAvg = (oldNotional + addNotional) / (oldQty + addQty);
                  if (hcCalc.loser === "long") {
                    setHcLongEntry(String(Math.round(newAvg * 100) / 100));
                    setHcLongMargin(String(hcCalc.baseMg));
                  } else {
                    setHcShortEntry(String(Math.round(newAvg * 100) / 100));
                    setHcShortMargin(String(hcCalc.baseMg));
                  }
                  setHcCycles((prev) => [...prev, {
                    profit: 0, note: "복구 완료", ts: Date.now(),
                  }]);
                }
              }} style={{
                width: "100%", padding: "14px 0", marginTop: 8, borderRadius: 10,
                border: `1px solid ${hcCalc.state === 3 ? "#0ea5e944" : "#34d39944"}`,
                background: hcCalc.state === 3 ? "#0ea5e910" : "#34d39910",
                color: hcCalc.state === 3 ? "#0ea5e9" : "#34d399",
                fontSize: 14, fontWeight: 700, cursor: "pointer",
                fontFamily: "'DM Sans'", letterSpacing: 0.5,
                transition: "all 0.15s",
              }}>
                {hcCalc.state === 3 ? "⚡ 복구 실행 (State 3 → 1)" : "⚡ 사이클 실행 (익절 + 손절)"}
              </button>
            )}

            {/* 킬 스위치 */}
            <div style={{
              ...S.card, marginTop: 4,
              borderColor: hcCalc.killAlert ? "#f8717144" : "#1e1e2e",
              background: hcCalc.killAlert ? "#f8717108" : "#08080f",
            }}>
              <div style={{ fontSize: 10, color: hcCalc.killAlert ? "#f87171" : "#6b7280", letterSpacing: 2, marginBottom: 8, fontFamily: "'DM Sans'" }}>
                {hcCalc.killAlert ? "🚨 킬 스위치 발동" : "안전장치"}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: "#94a3b8" }}>Equity: {fmt(hcCalc.equity)} USDT</span>
                <span style={{ color: hcCalc.equityPct < 90 ? "#f87171" : "#34d399" }}>{fmt(hcCalc.equityPct, 1)}%</span>
              </div>
              <div style={{ height: 6, background: "#1e1e2e", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  width: `${Math.max(Math.min(hcCalc.equityPct, 100), 0)}%`,
                  background: hcCalc.equityPct > 90 ? "#34d399" : hcCalc.equityPct > 85 ? "#f59e0b" : "#f87171",
                  transition: "width 0.3s",
                }} />
              </div>
              <div style={{ fontSize: 10, color: "#4b5563", marginTop: 4 }}>
                킬 스위치: {fmt(hcCalc.killThreshold)} USDT (-{hcKillPct}%) · 여유: {fmt(hcCalc.equity - hcCalc.killThreshold)} USDT
              </div>
              {hcCalc.killAlert && (
                <div style={{ fontSize: 12, color: "#f87171", fontWeight: 700, marginTop: 8, textAlign: "center" }}>
                  ⚠ 모든 포지션 즉시 청산 권고
                </div>
              )}
            </div>

            {/* 원웨이 시나리오 */}
            {hcCalc.onewayScenario.length > 0 && (
              <div style={{ ...S.card, marginTop: 4 }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  원웨이 시나리오 (되돌림 없이 계속 추세)
                </div>
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <TH>사이클</TH><TH>Loser 잔여 마진</TH><TH>누적 수익</TH><TH>누적 거래량</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {hcCalc.onewayScenario.map((s) => (
                        <tr key={s.cycle}>
                          <TD c="#e2e8f0">#{s.cycle}</TD>
                          <TD c={s.loserMg < 10 ? "#f87171" : "#94a3b8"}>{fmt(s.loserMg)} USDT</TD>
                          <TD c="#34d399">+{fmt(s.cumProfit)}</TD>
                          <TD c="#94a3b8">{fmt(s.cumVolume, 0)}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 사이클 히스토리 */}
            {hcCycles.length > 0 && (
              <div style={{ ...S.card, marginTop: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, fontFamily: "'DM Sans'" }}>
                    사이클 기록
                  </div>
                  <button onClick={() => { if (confirm("사이클 기록을 모두 삭제할까요?")) setHcCycles([]); }}
                    style={{ ...S.miniBtn, fontSize: 9, color: "#f87171" }}>기록 삭제</button>
                </div>
                {hcCycles.map((c, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", padding: "6px 0",
                    borderBottom: "1px solid #0e0e18", fontSize: 12,
                  }}>
                    <span style={{ color: "#6b7280" }}>#{i + 1}</span>
                    <span style={{ color: "#34d399" }}>+{fmt(c.profit)} USDT</span>
                    <span style={{ color: "#4b5563" }}>{c.note || ""}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                  <span style={{ color: "#6b7280" }}>누적: </span>
                  <span style={{ color: "#34d399" }}>+{fmt(hcCycles.reduce((a, c) => a + n(c.profit), 0))} USDT</span>
                </div>
              </div>
            )}

          </>)}

          <div style={S.footer}>
            Hedge Cycle Bot · 3-State 순환 · ROE = 미실현손익 / 전략마진
          </div>

        </>)}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   RESULT BLOCK
   ═══════════════════════════════════════════ */
function ResultBlock({ r, isLong, cp, mode, hasExLiq }) {
  const [customTarget, setCustomTarget] = useState("");
  const b = r.before;
  const a = r.after;
  const liqWorse = r.liqWorse;

  // Exit scenario calculations
  const fr = r.feeRate || 0;
  const calcExit = (targetPnL) => {
    // targetPnL: 수수료 차감 후 실현 PnL
    // Long: (exit - avg) × qty - avg×qty×fee - exit×qty×fee = targetPnL
    //   → exit = (targetPnL + avg×qty×(1+fee)) / (qty×(1-fee))
    // Short: (avg - exit) × qty - avg×qty×fee - exit×qty×fee = targetPnL
    //   → exit = (avg×qty×(1-fee) - targetPnL) / (qty×(1+fee))
    if (a.qty <= 0) return null;
    const exitPrice = isLong
      ? (targetPnL + a.avg * a.qty * (1 + fr)) / (a.qty * (1 - fr))
      : (a.avg * a.qty * (1 - fr) - targetPnL) / (a.qty * (1 + fr));
    if (exitPrice <= 0) return null;
    const changePct = cp > 0 ? ((exitPrice - cp) / cp) * 100 : 0;
    return { exitPrice, changePct, pnl: targetPnL };
  };

  // Presets: breakeven(0), +1%, +3%, +5% of margin
  const presets = [
    { label: "본전 (수수료 포함)", pnl: 0 },
    { label: `+1% 수익`, pnl: a.margin * 0.01 },
    { label: `+3% 수익`, pnl: a.margin * 0.03 },
    { label: `+5% 수익`, pnl: a.margin * 0.05 },
    { label: `+10% 수익`, pnl: a.margin * 0.10 },
  ];

  const customPnL = n(customTarget);
  const customExit = customPnL > 0 ? calcExit(customPnL) : null;

  return (
    <>
      {mode === "sim" && <div style={S.divider} />}
      {mode === "sim" && <Sec label="시뮬레이션 결과" />}
      {mode === "reverse" && <div style={{ height: 12 }} />}

      {/* Highlight cards */}
      <div style={S.hlGrid}>
        <HLCard label="새 평단가" value={`$${fmt(a.avg)}`}
          delta={`${fmtS(pct(a.avg - b.avg, b.avg))}%`}
          deltaColor={(isLong && a.avg < b.avg) || (!isLong && a.avg > b.avg) ? "#34d399" : "#f87171"} />

        {hasExLiq && a.liq != null ? (
          <HLCard label="새 청산가 (추정)" value={`$${fmt(a.liq)}`}
            delta={liqWorse ? "⚠ 위험" : "✓ 안전"}
            deltaColor={liqWorse ? "#f87171" : "#34d399"}
            sub={a.liqDist != null ? `현재가 대비 ${fmt(Math.abs(a.liqDist))}% 여유` : null} />
        ) : (
          <HLCard label="새 청산가" value="—"
            delta="거래소 청산가 입력 필요" deltaColor="#6b7280" />
        )}

        <HLCard label="탈출가 (수수료 포함)" value={`$${fmt(r.breakeven)}`}
          delta={`평단 대비 ${isLong ? "+" : ""}${fmt(Math.abs(r.moveNeeded), 3)}%`}
          deltaColor="#f59e0b" wide />
      </div>

      {/* Before / After table */}
      {cp > 0 && (
        <div style={S.tblWrap}>
          <table style={S.tbl}>
            <thead>
              <tr>
                <TH />
                <TH>균일가</TH><TH>마진</TH>
                {hasExLiq && <><TH>청산가</TH><TH>청산여유</TH></>}
                <TH>미실현 PnL (ROE)</TH>
              </tr>
            </thead>
            <tbody>
              <tr>
                <TD c="#6b7280">Before</TD>
                <TD>${fmt(b.avg)}</TD>
                <TD>{fmt(b.margin)}</TD>
                {hasExLiq && (
                  <>
                    <TD>{b.liq ? `$${fmt(b.liq)}` : "—"}</TD>
                    <TD>{b.liqDist != null ? `${fmt(Math.abs(b.liqDist))}%` : "—"}</TD>
                  </>
                )}
                <TD c={b.pnl >= 0 ? "#34d399" : "#f87171"}>
                  {fmtS(b.pnl)} ({fmtS(b.roe)}%)
                </TD>
              </tr>
              <tr style={{ background: "#0c0c18" }}>
                <TD c="#e2e8f0" bold>After</TD>
                <TD c="#0ea5e9">${fmt(a.avg)}</TD>
                <TD c="#e2e8f0">{fmt(a.margin)}</TD>
                {hasExLiq && (
                  <>
                    <TD c={liqWorse ? "#f87171" : "#34d399"}>
                      {a.liq != null ? `$${fmt(a.liq)}` : "—"}
                    </TD>
                    <TD c={liqWorse ? "#f87171" : "#34d399"}>
                      {a.liqDist != null ? `${fmt(Math.abs(a.liqDist))}%` : "—"}
                    </TD>
                  </>
                )}
                <TD c={a.pnl >= 0 ? "#34d399" : "#f87171"} bold>
                  {fmtS(a.pnl)} ({fmtS(a.roe)}%)
                </TD>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Details */}
      <div style={S.detBox}>
        <div style={S.detTitle}>DETAILS</div>
        {r.addTotalFeeDeduct > 0 && (
          <>
            <SL label="투입 금액" value={`${fmt(r.addTotalRawMargin)} USDT`} />
            <SL label="수수료 예약 (진입+청산)" value={`-${fmt(r.addTotalFeeDeduct)} USDT`} warn />
            <SL label="실제 추가 마진" value={`${fmt(r.addTotalMargin)} USDT`} />
            {r.dcaList && r.dcaList.length > 1 && (
              <div style={{ padding: "6px 0 2px", borderBottom: "1px solid #0e0e18" }}>
                {r.dcaList.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4b5563", padding: "2px 0" }}>
                    <span>#{i + 1} ${fmt(d.price)} · {fmt(d.rawMargin, 0)}</span>
                    <span style={{ color: "#f59e0b" }}>수수료 {fmt(d.feeDeduct)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <SL label="예상 수수료 (진입+청산)" value={`${fmt(r.totalFee)} USDT`} />
        <SL label="물타기 후 사용 가능" value={`${fmt(r.afterFreeMargin, 0)} USDT`}
          warn={r.afterFreeMargin < 0} />
        {r.marginInsufficient && <SL label="⚠ 잔고 상태" value="마진 부족" warn />}
        {r.marginInsufficient && r.shortfallInfo && (
          <div style={S.shortfallBox}>
            {r.shortfallInfo.impossible ? (
              <span>현재 포지션 구조에서 마진 확보 불가</span>
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>
                  부족분: <span style={{ color: "#f87171", fontWeight: 600 }}>{fmt(r.shortfallInfo.shortfall)} USDT</span>
                </div>
                <div>
                  <span style={{ color: "#0ea5e9", fontWeight: 600 }}>${fmt(r.shortfallInfo.price)}</span> 도달 시 물타기 가능
                  <span style={{ color: r.shortfallInfo.changePct > 0 ? "#34d399" : "#f87171", marginLeft: 6 }}>
                    (현재가 대비 {fmtS(r.shortfallInfo.changePct)}%)
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {liqWorse && (
        <div style={S.warnBox}>
          ⚠ 물타기 후 청산가가 현재가에 더 가까워졌습니다. 교차 마진에서는 지갑 전체 잔고가 위험에 노출됩니다.
        </div>
      )}

      {/* ── EXIT SCENARIOS ── */}
      {cp > 0 && a.qty > 0 && (
        <div style={S.exitBox}>
          <div style={S.exitTitle}>탈출 시나리오</div>
          <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 12 }}>
            물타기 후 포지션을 청산할 때의 목표별 가격
          </div>
          <div style={S.tblWrap}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  <TH>목표</TH>
                  <TH>탈출가</TH>
                  <TH>현재가 대비</TH>
                  <TH>실현 PnL</TH>
                </tr>
              </thead>
              <tbody>
                {presets.map((p, i) => {
                  const ex = calcExit(p.pnl);
                  if (!ex) return null;
                  return (
                    <tr key={i} style={i === 0 ? { background: "#0c0c18" } : {}}>
                      <TD c={i === 0 ? "#f59e0b" : "#94a3b8"}>{p.label}</TD>
                      <TD c={i === 0 ? "#f59e0b" : "#e2e8f0"}>${fmt(ex.exitPrice)}</TD>
                      <TD c={ex.changePct >= 0 ? "#34d399" : "#f87171"}>
                        {fmtS(ex.changePct)}%
                      </TD>
                      <TD c={ex.pnl >= 0 ? "#34d399" : "#94a3b8"}>
                        {fmtS(ex.pnl)} USDT
                      </TD>
                    </tr>
                  );
                })}
                {customExit && (
                  <tr style={{ background: "#0a1020" }}>
                    <TD c="#0ea5e9">커스텀</TD>
                    <TD c="#0ea5e9">${fmt(customExit.exitPrice)}</TD>
                    <TD c={customExit.changePct >= 0 ? "#34d399" : "#f87171"}>
                      {fmtS(customExit.changePct)}%
                    </TD>
                    <TD c="#0ea5e9">
                      {fmtS(customExit.pnl)} USDT
                    </TD>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={S.exitCustomRow}>
            <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>목표 수익:</span>
            <input type="number" value={customTarget}
              placeholder="직접 입력 (USDT)"
              onChange={(e) => setCustomTarget(e.target.value)}
              style={{ ...S.inp, fontSize: 12, padding: "7px 10px", flex: 1 }}
              onFocus={(e) => (e.target.style.borderColor = "#0ea5e9")}
              onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
            <span style={{ fontSize: 11, color: "#4b5563" }}>USDT</span>
          </div>
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   SUB COMPONENTS
   ═══════════════════════════════════════════ */
function Sec({ label, accent, pyra }) {
  const accentColor = pyra ? "#f59e0b" : "#0ea5e9";
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase",
      color: (accent || pyra) ? accentColor : "#4b5563", fontFamily: "'DM Sans'",
      margin: "28px 0 10px", display: "flex", alignItems: "center", gap: 8,
    }}>
      {(accent || pyra) && <div style={{ width: 3, height: 14, background: accentColor, borderRadius: 2 }} />}
      {label}
    </div>
  );
}
function Fld({ label, children }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>{label}</div>
      {children}
    </div>
  );
}
function Inp({ value, onChange, ph }) {
  return (
    <input type="number" value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)}
      style={S.inp}
      onFocus={(e) => (e.target.style.borderColor = "#0ea5e9")}
      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
  );
}

/* 가격 입력 + 현재가/±% 빠른 버튼 */
function PriceInp({ value, onChange, ph, cp, mode, accentColor }) {
  // mode: "dca" = 물타기(평단 유리 방향), "pyra" = 불타기(추세 방향), "close" = 양방향, "entry" = 양방향
  // accentColor: 버튼 강조색 (기본 #0ea5e9)
  const ac = accentColor || "#0ea5e9";
  const hasCp = cp > 0;
  const pctCalc = (pct) => String(Math.round(cp * (1 + pct / 100) * 100) / 100);

  // 방향별 % 프리셋
  let pctPresets = [];
  if (mode === "dca-long") pctPresets = [{ l: "-1%", v: -1 }, { l: "-3%", v: -3 }, { l: "-5%", v: -5 }];
  else if (mode === "dca-short") pctPresets = [{ l: "+1%", v: 1 }, { l: "+3%", v: 3 }, { l: "+5%", v: 5 }];
  else if (mode === "pyra-long") pctPresets = [{ l: "+1%", v: 1 }, { l: "+3%", v: 3 }, { l: "+5%", v: 5 }];
  else if (mode === "pyra-short") pctPresets = [{ l: "-1%", v: -1 }, { l: "-3%", v: -3 }, { l: "-5%", v: -5 }];
  else pctPresets = [{ l: "-3%", v: -3 }, { l: "-1%", v: -1 }, { l: "+1%", v: 1 }, { l: "+3%", v: 3 }];

  const btnS = { padding: "2px 0", fontSize: 8, fontWeight: 600, borderRadius: 3, cursor: "pointer", border: `1px solid ${ac}22`, background: `${ac}08`, color: `${ac}99`, fontFamily: "'DM Sans'", flex: 1, minWidth: 0, transition: "all 0.12s" };

  return (
    <div>
      <input type="number" value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)}
        style={S.inp}
        onFocus={(e) => (e.target.style.borderColor = ac)}
        onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
      {hasCp && (
        <div style={{ display: "flex", gap: 2, marginTop: 3 }}>
          <button onClick={() => onChange(String(cp))} style={{ ...btnS, background: `${ac}15`, color: ac, fontWeight: 700, fontSize: 9 }}>현재가</button>
          {pctPresets.map((p) => (
            <button key={p.l} onClick={() => onChange(pctCalc(p.v))} style={btnS}>{p.l}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* 마진 빠른 입력 프리셋 */
function MarginPresets({ freeMargin, onSelect, accentColor }) {
  const ac = accentColor || "#0ea5e9";
  if (!freeMargin || freeMargin <= 0) return null;
  const presets = [
    { label: "전액", pct: 100 },
    { label: "50%", pct: 50 },
    { label: "25%", pct: 25 },
    { label: "10%", pct: 10 },
    { label: "5%", pct: 5 },
  ];
  const btnS = { padding: "2px 0", fontSize: 8, fontWeight: 600, borderRadius: 3, cursor: "pointer", border: `1px solid ${ac}22`, background: `${ac}08`, color: `${ac}99`, fontFamily: "'DM Sans'", flex: 1, minWidth: 0, transition: "all 0.12s" };
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginTop: 3 }}>
        {presets.map((p) => (
          <button key={p.pct} onClick={() => onSelect(String(Math.floor(freeMargin * p.pct / 100 * 100) / 100))} style={btnS}>{p.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 2, textAlign: "right", fontFamily: "'DM Sans'" }}>
        여유: {freeMargin.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} USDT
      </div>
    </div>
  );
}

/* 분할 매수 가격 자동 생성 */
function SplitAutoGen({ cp, isLong, onGenerate, accentColor }) {
  const [gap, setGap] = useState("2");
  const [count, setCount] = useState("3");
  const ac = accentColor || "#0ea5e9";
  if (!cp || cp <= 0) return null;

  const generate = () => {
    const g = Number(gap) || 2;
    const c = Math.min(Math.max(Number(count) || 3, 2), 10);
    const sign = isLong ? -1 : 1;
    const prices = Array.from({ length: c }, (_, i) =>
      String(Math.round(cp * (1 + sign * (i + 1) * g / 100) * 100) / 100)
    );
    onGenerate(prices);
  };

  const inputS = { ...S.inp, fontSize: 11, padding: "5px 8px", width: "100%" };
  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "#06060e", border: `1px solid ${ac}15` }}>
      <div style={{ fontSize: 10, color: ac, fontWeight: 600, marginBottom: 6, fontFamily: "'DM Sans'" }}>
        자동 생성 (현재가 ${cp.toLocaleString()} 기준)
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9, color: "#4b5563", marginBottom: 2 }}>간격 (%)</div>
          <input type="number" value={gap} onChange={(e) => setGap(e.target.value)} style={inputS} placeholder="2" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9, color: "#4b5563", marginBottom: 2 }}>개수</div>
          <input type="number" value={count} onChange={(e) => setCount(e.target.value)} style={inputS} placeholder="3" />
        </div>
        <button onClick={generate} style={{
          padding: "6px 12px", fontSize: 10, fontWeight: 600, borderRadius: 6,
          border: `1px solid ${ac}44`, background: `${ac}15`, color: ac,
          cursor: "pointer", fontFamily: "'DM Sans'", whiteSpace: "nowrap",
        }}>생성</button>
      </div>
      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 4, fontFamily: "'DM Sans'" }}>
        {isLong ? "▼ 현재가 아래로" : "▲ 현재가 위로"} {gap}% 간격 · {count}개
      </div>
    </div>
  );
}

function InputCalc({ pos, ep, lev, fee, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("");

  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen(!open)} style={{
        background: "none", border: "none", padding: 0,
        fontSize: 10, color: open ? "#0ea5e9" : "#4b5563",
        cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
      }}>
        {open ? "▾ 투입금액 계산기 닫기" : "💰 투입금액으로 계산"}
      </button>
      {open && (
        <div style={{
          marginTop: 4, padding: 8, background: "#06060e",
          borderRadius: 6, border: "1px solid #1e1e2e",
        }}>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>
            투입금액을 입력하면 수수료를 차감한 표시 마진을 자동 계산합니다
          </div>
          <Inp value={amt} onChange={(v) => {
            setAmt(v);
            if (ep > 0 && n(v) > 0 && lev > 0) {
              const conv = fromInput(n(v), ep, lev, fee, pos.dir, pos.coin);
              if (conv) onUpdate(pos.id, "margin", String(Math.round(conv.margin * 1e6) / 1e6));
            }
          }} ph="실제 넣은 금액 (예: 300)" />
          {ep > 0 && n(amt) > 0 && (() => {
            const conv = fromInput(n(amt), ep, lev, fee, pos.dir, pos.coin);
            if (!conv) return <div style={{ fontSize: 10, color: "#f87171", marginTop: 4 }}>계산 불가 (값 확인)</div>;
            return (
              <div style={{ marginTop: 6, fontSize: 10, color: "#4b5563", lineHeight: 1.6 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>표시 마진</span><span style={{ color: "#cbd5e1" }}>{fmt(conv.margin)} USDT</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>진입 수수료</span><span style={{ color: "#f59e0b" }}>-{fmt(conv.openCost)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>청산 수수료 예약</span><span style={{ color: "#f59e0b" }}>-{fmt(conv.closeCost)}</span>
                </div>
                {conv.change > 0.01 && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>잔돈 (수량 내림)</span><span>{fmt(conv.change)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between",
                              marginTop: 2, borderTop: "1px solid #1e1e2e", paddingTop: 2 }}>
                  <span>수량</span><span style={{ color: "#cbd5e1" }}>{fmt(conv.qty, 4)} {pos.coin}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 9, color: "#6b728088" }}>
                  ※ 거래소 실제 수량과 소폭 차이가 있을 수 있습니다
                </div>
              </div>
            );
          })()}
          {ep <= 0 && n(amt) > 0 && (
            <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 4 }}>
              진입가를 먼저 입력하세요
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PosCard({ pos, idx, isSel, isPyraLocked, isPyraCounter, onSelect, onPyra, onUpdate, onRemove, canRemove, cp, fee }) {
  const [showMoreCoins, setShowMoreCoins] = useState(false);
  const dirC = pos.dir === "long" ? "#34d399" : "#f87171";
  const ep = n(pos.entryPrice), mg = n(pos.margin), lev = n(pos.leverage);
  const notional = mg * lev;
  const qty = ep > 0 ? notional / ep : 0;
  const liveNotional = cp > 0 && qty > 0 ? qty * cp : notional;
  const sign = pos.dir === "long" ? 1 : -1;
  const pnl = cp > 0 && qty > 0 ? sign * (cp - ep) * qty : null;
  const roe = pnl != null && mg > 0 ? (pnl / mg) * 100 : null;
  const isEmpty = ep === 0 && mg === 0;

  const borderColor = isPyraCounter ? "#f59e0b" : isPyraLocked ? "#6b728044" : isSel ? "#0ea5e9" : "#1e1e2e";
  const bgColor = isPyraCounter ? "#120e04" : isPyraLocked ? "#0a0a0e" : isSel ? "#060a14" : "#08080f";

  const isPrimary = COINS_PRIMARY.includes(pos.coin);
  const coinBtnStyle = (c) => ({
    padding: "6px 0", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer",
    border: `1px solid ${pos.coin === c ? "#0ea5e944" : "#1e1e2e"}`,
    background: pos.coin === c ? "#0ea5e912" : "transparent",
    color: pos.coin === c ? "#0ea5e9" : "#6b7280",
    fontFamily: "'IBM Plex Mono'", transition: "all 0.15s",
    flex: 1, minWidth: 0,
  });

  return (
    <div style={{ ...S.card, borderColor, background: bgColor }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#4b5563" }}>#{idx + 1}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: dirC, padding: "2px 8px", borderRadius: 4,
            background: pos.dir === "long" ? "#34d39912" : "#f8717112",
            border: `1px solid ${dirC}33`,
          }}>{pos.dir === "long" ? "LONG" : "SHORT"}</span>
          {isPyraLocked && (
            <span style={{ fontSize: 10, color: "#6b7280", fontWeight: 600 }}>🔒 물린 포지션</span>
          )}
          {isPyraCounter && (
            <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600 }}>🔥 불타기 대상</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onSelect} style={{
            ...S.miniBtn,
            background: isSel ? "#0ea5e915" : "transparent",
            borderColor: isSel ? "#0ea5e944" : "#1e1e2e",
            color: isSel ? "#0ea5e9" : "#6b7280",
          }}>{isSel ? "✓ 선택됨" : "물타기"}</button>
          <button onClick={onPyra} style={{
            ...S.miniBtn,
            background: isPyraCounter ? "#f59e0b15" : "transparent",
            borderColor: isPyraCounter ? "#f59e0b44" : "#1e1e2e",
            color: isPyraCounter ? "#f59e0b" : "#6b7280",
          }}>{isPyraCounter ? "✓ 불타기" : "🔥"}</button>
          {canRemove && <button onClick={onRemove} style={{ ...S.miniBtn, color: "#f87171", borderColor: "#1e1e2e" }}>삭제</button>}
        </div>
      </div>

      {/* 코인 선택: 버튼 그룹 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: isEmpty ? "#94a3b8" : "#6b7280", marginBottom: 5, fontFamily: "'DM Sans'", fontWeight: isEmpty ? 600 : 400 }}>
          {isEmpty ? "코인 선택" : "코인"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {COINS_PRIMARY.map((c) => (
            <button key={c} onClick={() => { onUpdate(pos.id, "coin", c); setShowMoreCoins(false); }} style={coinBtnStyle(c)}>
              {c}
            </button>
          ))}
          <button
            onClick={() => setShowMoreCoins(!showMoreCoins)}
            style={{
              ...coinBtnStyle("__more__"),
              flex: "none", width: 40,
              border: `1px solid ${(!isPrimary || showMoreCoins) ? "#0ea5e944" : "#1e1e2e"}`,
              background: (!isPrimary || showMoreCoins) ? "#0ea5e912" : "transparent",
              color: (!isPrimary || showMoreCoins) ? "#0ea5e9" : "#4b5563",
              fontSize: 10,
            }}
          >
            {!isPrimary ? pos.coin : "···"}
          </button>
        </div>
        {showMoreCoins && (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {COINS_MORE.map((c) => (
              <button key={c} onClick={() => { onUpdate(pos.id, "coin", c); setShowMoreCoins(false); }} style={coinBtnStyle(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 방향 + 레버리지 */}
      <div style={S.grid2}>
        <Fld label="방향">
          <div style={{ display: "flex", gap: 4 }}>
            {["long", "short"].map((d) => (
              <button key={d} onClick={() => onUpdate(pos.id, "dir", d)} style={{
                flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                border: `1px solid ${pos.dir === d ? (d === "long" ? "#34d39933" : "#f8717133") : "#1e1e2e"}`,
                background: pos.dir === d ? (d === "long" ? "#34d39910" : "#f8717110") : "transparent",
                color: pos.dir === d ? (d === "long" ? "#34d399" : "#f87171") : "#4b5563",
                fontFamily: "'DM Sans'",
              }}>{d === "long" ? "롱" : "숏"}</button>
            ))}
          </div>
        </Fld>
        <Fld label="레버리지">
          <select value={pos.leverage} onChange={(e) => onUpdate(pos.id, "leverage", Number(e.target.value))} style={S.sel}>
            {LEV_PRESETS.map((l) => <option key={l} value={l}>x{l}</option>)}
          </select>
        </Fld>
      </div>
      <div style={{ ...S.grid2, marginTop: 8 }}>
        <Fld label="평균 진입가 ($)">
          <PriceInp value={pos.entryPrice} onChange={(v) => onUpdate(pos.id, "entryPrice", v)} ph="거래소에서 확인" cp={cp} mode="entry" />
        </Fld>
        <Fld label="표시 마진 (USDT)">
          <Inp value={pos.margin} onChange={(v) => onUpdate(pos.id, "margin", v)} ph="거래소에서 확인" />
          <InputCalc pos={pos} ep={ep} lev={lev} fee={fee} onUpdate={onUpdate} />
        </Fld>
      </div>
      {ep > 0 && mg > 0 && (
        <div style={S.autoRow}>
          {pnl != null && (
            <span style={{ color: pnl >= 0 ? "#34d399" : "#f87171" }}>
              PnL: {fmtS(pnl)} ({fmtS(roe)}%)
            </span>
          )}
          <span style={{ color: "#4b5563" }}>
            포지션: {fmt(liveNotional, 0)}{cp > 0 && liveNotional !== notional ? ` (진입 시 ${fmt(notional, 0)})` : ""}
          </span>
          {qty > 0 && <span style={{ color: "#4b5563" }}>수량: {fmt(qty, 4)}</span>}
        </div>
      )}
    </div>
  );
}

function SumCard({ label, value, color, sub }) {
  return (
    <div style={S.sumCard}>
      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'IBM Plex Mono'" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#4b5563", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function HLCard({ label, value, delta, deltaColor, sub, wide }) {
  return (
    <div style={{ ...S.hlCard, gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: wide ? 22 : 20, fontWeight: 700, color: "#f1f5f9", fontFamily: "'DM Sans'" }}>{value}</div>
      {delta && <div style={{ fontSize: 12, color: deltaColor, marginTop: 4, fontWeight: 500 }}>{delta}</div>}
      {sub && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function TH({ children }) { return <th style={S.th}>{children}</th>; }
function TD({ children, c, bold }) { return <td style={{ ...S.td, color: c || "#94a3b8", fontWeight: bold ? 600 : 400 }}>{children}</td>; }
function SL({ label, value, warn }) {
  return (
    <div style={S.sl}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color: warn ? "#f87171" : "#cbd5e1", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════ */
const S = {
  root: {
    minHeight: "100vh", background: "#050508", color: "#cbd5e1",
    fontFamily: "'IBM Plex Mono', monospace", padding: "20px 12px",
  },
  wrap: { maxWidth: 760, margin: "0 auto" },
  hdr: { marginBottom: 28, paddingBottom: 20, borderBottom: "1px solid #111118" },
  hdrRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  hdrDot: { width: 6, height: 6, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 8px #34d39944" },
  hdrBadge: { fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: "#34d399", fontFamily: "'DM Sans'" },
  hdrTitle: { fontSize: 28, fontWeight: 800, color: "#f8fafc", fontFamily: "'DM Sans'", letterSpacing: -0.5 },
  hdrSub: { fontSize: 12, color: "#4b5563", marginTop: 4, fontFamily: "'DM Sans'" },

  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },

  inp: {
    width: "100%", padding: "10px 12px", background: "#0a0a12", border: "1px solid #1e1e2e",
    borderRadius: 8, color: "#e2e8f0", fontSize: 14, fontFamily: "'IBM Plex Mono'",
    outline: "none", transition: "border-color 0.15s",
  },
  sel: {
    width: "100%", padding: "10px 12px", background: "#0a0a12", border: "1px solid #1e1e2e",
    borderRadius: 8, color: "#e2e8f0", fontSize: 13, fontFamily: "'IBM Plex Mono'",
    outline: "none", appearance: "none", WebkitAppearance: "none",
  },

  card: {
    padding: 16, borderRadius: 12, border: "1px solid #1e1e2e", background: "#08080f",
    marginBottom: 10, transition: "border-color 0.2s",
  },
  miniBtn: {
    padding: "4px 10px", fontSize: 11, fontWeight: 500, border: "1px solid #1e1e2e",
    borderRadius: 6, background: "transparent", cursor: "pointer", fontFamily: "'DM Sans'",
  },
  autoRow: {
    marginTop: 10, padding: "8px 10px", background: "#0a0a14", borderRadius: 6,
    fontSize: 11, color: "#4b5563", display: "flex", gap: 16, flexWrap: "wrap",
  },
  addBtn: {
    width: "100%", padding: "10px 0", border: "1px dashed #1e1e2e", borderRadius: 8,
    background: "transparent", color: "#4b5563", cursor: "pointer", fontSize: 12,
    fontFamily: "'DM Sans'", marginTop: 6,
  },

  summaryGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  sumCard: { padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e" },

  availBox: {
    marginTop: 8, padding: 14, borderRadius: 10,
    background: "#08080f", border: "1px solid #1e1e2e",
  },
  availRow: { display: "flex", gap: 8, alignItems: "stretch" },

  shortfallBox: {
    marginTop: 8, padding: 10, borderRadius: 6,
    background: "#0ea5e908", border: "1px solid #0ea5e922",
    fontSize: 12, color: "#cbd5e1", lineHeight: 1.6,
  },

  liqBar: {
    marginTop: 10, padding: 16, borderRadius: 10,
    background: "#08080f", border: "1px solid #1e1e2e",
  },
  liqBarInner: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
  liqVisual: { marginTop: 12 },
  liqTrack: { height: 6, background: "#1e1e2e", borderRadius: 3, overflow: "hidden" },
  liqFill: { height: "100%", borderRadius: 3, transition: "width 0.3s" },
  liqEmpty: {
    marginTop: 10, padding: 14, borderRadius: 8, background: "#08080f",
    border: "1px dashed #1e1e2e", textAlign: "center", fontSize: 12, color: "#4b5563",
  },

  modeRow: { display: "flex", gap: 6, marginBottom: 12 },
  modeBtn: {
    flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 600, borderRadius: 8,
    border: "1px solid #1e1e2e", cursor: "pointer", fontFamily: "'DM Sans'",
    background: "transparent", transition: "all 0.15s",
  },
  splitToggle: {
    width: "100%", padding: "8px 0", marginTop: 6, border: "1px dashed #1e1e2e",
    borderRadius: 8, background: "transparent", color: "#4b5563", cursor: "pointer",
    fontSize: 11, fontFamily: "'DM Sans'", transition: "all 0.15s",
  },
  splitPanel: {
    marginTop: 8, padding: 14, borderRadius: 10,
    background: "#06060e", border: "1px solid #1e1e2e",
  },
  splitGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8,
  },
  splitCard: {
    padding: 12, borderRadius: 8, border: "1px solid #1e1e2e", background: "#0a0a14",
  },
  applyBtn: {
    padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 4,
    border: "1px solid #0ea5e933", background: "#0ea5e910", color: "#0ea5e9",
    cursor: "pointer", fontFamily: "'DM Sans'", whiteSpace: "nowrap",
  },
  dcaRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  dcaNum: {
    width: 24, height: 24, borderRadius: "50%", background: "#0ea5e915", border: "1px solid #0ea5e933",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, color: "#0ea5e9", fontWeight: 600, flexShrink: 0,
  },
  rmSm: {
    width: 32, height: 40, border: "1px solid #1e1e2e", background: "transparent",
    color: "#f87171", borderRadius: 6, cursor: "pointer", fontSize: 16,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  empty: { textAlign: "center", padding: "36px 16px", color: "#333", fontSize: 13, fontFamily: "'DM Sans'" },
  divider: { height: 1, margin: "28px 0", background: "linear-gradient(90deg, transparent, #0ea5e922, transparent)" },

  hlGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 },
  hlCard: { padding: 16, borderRadius: 10, background: "#0a0a14", border: "1px solid #1e1e2e" },

  revHL: {
    padding: 20, borderRadius: 12, background: "#0a0a14", border: "1px solid #0ea5e944",
    marginBottom: 12, textAlign: "center", fontFamily: "'DM Sans'",
  },

  tblWrap: { overflowX: "auto", borderRadius: 10, border: "1px solid #1e1e2e", marginBottom: 12 },
  tbl: { width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'IBM Plex Mono'" },
  th: {
    padding: "10px 10px", textAlign: "left", color: "#4b5563", fontWeight: 500, fontSize: 10,
    letterSpacing: 0.5, borderBottom: "1px solid #1e1e2e", background: "#08080f",
    whiteSpace: "nowrap", fontFamily: "'DM Sans'",
  },
  td: { padding: "10px 10px", borderBottom: "1px solid #111118", whiteSpace: "nowrap" },

  detBox: { padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginBottom: 12 },
  detTitle: { fontSize: 10, color: "#4b5563", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" },
  sl: { display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #0e0e18", fontSize: 12 },

  warnBox: {
    padding: 14, borderRadius: 8, background: "#f8717108", border: "1px solid #f8717122",
    fontSize: 12, color: "#f87171", lineHeight: 1.6, marginBottom: 12,
  },

  exitBox: {
    padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e",
    marginBottom: 12,
  },
  exitTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase",
    color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 4,
  },
  exitCustomRow: {
    display: "flex", alignItems: "center", gap: 8, marginTop: 10,
  },

  cdBox: {
    padding: 16, borderRadius: 10,
    background: "#0a0a14", border: "1px solid #0ea5e922",
    marginBottom: 12,
  },
  cdTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase",
    color: "#0ea5e9", fontFamily: "'DM Sans'", marginBottom: 4,
  },

  footer: { marginTop: 28, textAlign: "center", fontSize: 11, color: "#333", fontFamily: "'DM Sans'" },
};
