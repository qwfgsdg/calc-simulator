import { useState, useCallback, useMemo } from "react";

/* ═══════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════ */
const uid = () => Math.random().toString(36).slice(2, 9);
const COINS = ["ETH", "BTC", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK"];
const LEV_PRESETS = [5, 10, 20, 25, 50, 75, 100, 125];

const n = (v) => Number(v) || 0;
const fmt = (v, d = 2) =>
  v != null && isFinite(v)
    ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";
const fmtS = (v, d = 2) => (v >= 0 ? "+" : "") + fmt(v, d);
const pct = (a, b) => (b !== 0 ? (a / b) * 100 : 0);

/* ═══════════════════════════════════════════
   DATA FACTORIES
   ═══════════════════════════════════════════ */
const mkPos = (ov = {}) => ({
  id: uid(), dir: "long", coin: "ETH",
  entryPrice: "", margin: "", leverage: 50, ...ov,
});
const mkDCA = () => ({ id: uid(), price: "", margin: "" });

/* ═══════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════ */
export default function SimV4() {
  const [wallet, setWallet] = useState("9120.57");
  const [curPrice, setCurPrice] = useState("");
  const [feeRate, setFeeRate] = useState("0.04");
  const [exLiqPrice, setExLiqPrice] = useState("171.36");

  const [positions, setPositions] = useState([
    mkPos({ dir: "long", coin: "ETH", entryPrice: "3265.75707264", margin: "373.60", leverage: 50 }),
    mkPos({ dir: "short", coin: "ETH", entryPrice: "1952.15", margin: "188.28", leverage: 50 }),
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
  };

  const addDCA = () => setDcaEntries((d) => [...d, mkDCA()]);
  const rmDCA = (id) => setDcaEntries((d) => d.filter((x) => x.id !== id));
  const updDCA = useCallback((id, k, v) =>
    setDcaEntries((ds) => ds.map((d) => (d.id === id ? { ...d, [k]: v } : d))), []);

  /* ═══════════════════════════════════════════
     CORE CALCULATIONS
     ═══════════════════════════════════════════ */
  const calc = useMemo(() => {
    const wb = n(wallet);
    const cp = n(curPrice);
    const fee = n(feeRate) / 100;
    const exLiq = n(exLiqPrice);
    if (!wb) return null;

    // ── Parse positions ──
    const parsed = positions.map((p) => {
      const ep = n(p.entryPrice);
      const mg = n(p.margin);
      const lev = n(p.leverage);
      const notional = mg * lev;
      const qty = ep > 0 ? notional / ep : 0;
      const sign = p.dir === "long" ? 1 : -1;
      let pnl = 0, roe = 0;
      if (cp > 0 && qty > 0) {
        pnl = sign * (cp - ep) * qty;
        roe = pct(pnl, mg);
      }
      return { ...p, ep, mg, lev, notional, qty, sign, pnl, roe };
    }).filter((p) => p.ep > 0 && p.mg > 0);

    // ── Account summary ──
    const totalPnL = parsed.reduce((a, p) => a + p.pnl, 0);
    const equity = wb + totalPnL;
    const totalMargin = parsed.reduce((a, p) => a + p.mg, 0);
    const freeMargin = equity - totalMargin;

    // ── Reverse-engineer maintenance margin from exchange liq price ──
    // At liqPrice, equity = MM_actual
    // equity(liqPrice) = wb + Σ sign_i × (liqPrice - ep_i) × qty_i
    let mmActual = null;
    let mmRate = null;
    let liqDistPct = null;

    if (exLiq > 0 && parsed.length > 0) {
      mmActual = wb + parsed.reduce((a, p) => a + p.sign * (exLiq - p.ep) * p.qty, 0);

      // MMR = mmActual / totalNotionalAtLiqPrice
      const totalNotionalAtLiq = parsed.reduce((a, p) => a + p.qty * exLiq, 0);
      if (totalNotionalAtLiq > 0) {
        mmRate = mmActual / totalNotionalAtLiq;
      }

      if (cp > 0) {
        liqDistPct = ((cp - exLiq) / cp) * 100;
      }
    }

    // ── Selected position ──
    const sel = parsed.find((p) => p.id === selId);

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

    // ── Build DCA result (sim mode) ──
    let dcaResult = null;
    if (sel && dcaMode === "sim") {
      const dcaList = dcaEntries
        .filter((e) => n(e.price) > 0 && n(e.margin) > 0)
        .map((e) => {
          const price = n(e.price);
          const addMargin = n(e.margin);
          const addNotional = addMargin * sel.lev;
          const addQty = addNotional / price;
          return { price, margin: addMargin, notional: addNotional, qty: addQty };
        });

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

        // Breakeven
        const totalFee = newNotional * fee * 2;
        const breakeven = sel.dir === "long"
          ? newAvg + totalFee / newQty
          : newAvg - totalFee / newQty;
        const moveNeeded = pct(breakeven - newAvg, newAvg);

        // Free margin after
        const afterTotalMargin = totalMargin + addTotalMargin;
        const afterEquity = wb + parsed.reduce((a, p) => {
          if (p.id === sel.id) return a + sel.sign * (cp > 0 ? (cp - newAvg) * newQty : 0);
          return a + p.pnl;
        }, 0);
        const afterFreeMargin = afterEquity - afterTotalMargin;

        const isLong = sel.dir === "long";
        const liqWorse = exLiq > 0 && afterLiq != null &&
          (isLong ? afterLiq > exLiq : afterLiq < exLiq);

        dcaResult = {
          dcaList, addTotalMargin,
          before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
          after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
          breakeven, moveNeeded, totalFee,
          afterFreeMargin, liqWorse,
          avgDelta: newAvg - sel.ep,
          avgDeltaPct: pct(newAvg - sel.ep, sel.ep),
          marginInsufficient: addTotalMargin > Math.max(freeMargin, 0),
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

            const totalFee = newNotional * fee * 2;
            const breakeven = isLong
              ? newAvg + totalFee / newQty
              : newAvg - totalFee / newQty;
            const moveNeeded = pct(breakeven - newAvg, newAvg);

            const afterTotalMargin = totalMargin + addMargin;
            const afterFreeMargin = equity - afterTotalMargin;

            const liqWorse = exLiq > 0 && afterLiq != null &&
              (isLong ? afterLiq > exLiq : afterLiq < exLiq);

            let maxReachableAvg = null;
            if (addMargin > Math.max(freeMargin, 0) && freeMargin > 0) {
              const maxNotional = freeMargin * sel.lev;
              const maxQty = maxNotional / rp;
              maxReachableAvg = (sel.notional + maxNotional) / (sel.qty + maxQty);
            }

            revResult = {
              impossible: false,
              requiredMargin: addMargin,
              requiredNotional: addNotional, addQty,
              before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
              after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
              breakeven, moveNeeded, totalFee,
              afterFreeMargin, liqWorse,
              marginInsufficient: addMargin > Math.max(freeMargin, 0),
              maxReachableAvg,
            };
          }
        }
      }
    }

    // ── Solve price for target available amount ──
    // available(P) = wb + P*A - B - totalMargin, where A = Σ(sign_i * qty_i), B = Σ(sign_i * ep_i * qty_i)
    // P = (T + B + totalMargin - wb) / A
    const sumA = parsed.reduce((a, p) => a + p.sign * p.qty, 0);
    const sumB = parsed.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);

    const solvePriceForAvail = (target, posArr, extraMargin = 0) => {
      const sA = posArr ? posArr.reduce((a, p) => a + p.sign * p.qty, 0) : sumA;
      const sB = posArr ? posArr.reduce((a, p) => a + p.sign * p.ep * p.qty, 0) : sumB;
      const tMg = (posArr ? posArr.reduce((a, p) => a + p.mg, 0) : totalMargin) + extraMargin;
      if (Math.abs(sA) < 1e-12) return null;
      const P = (target + sB + tMg - wb) / sA;
      return P > 0 ? P : null;
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
          availCalc = { sufficient: false, impossible: true };
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
        const remFreeMargin = remEquity - remTotalMargin;

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
            const dcaMargin = remFreeMargin;
            const dcaNotional = dcaMargin * sel.lev;
            const dcaQty = dcaNotional / dcaPrice;
            const newQty2 = remQty + dcaQty;
            const newNotional2 = remNotional + dcaNotional;
            const newAvg2 = newNotional2 / newQty2;
            const newMargin2 = remMargin + dcaMargin;

            const afterPnL2 = sel.sign * (cp - newAvg2) * newQty2;
            const afterROE2 = newMargin2 > 0 ? pct(afterPnL2, newMargin2) : 0;

            const totalFee2 = newNotional2 * fee * 2;
            const breakeven2 = sel.dir === "long"
              ? newAvg2 + totalFee2 / newQty2
              : newAvg2 - totalFee2 / newQty2;

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
            const margin = sTotal * strat.weights[i] / totalWeight;
            const notional = margin * sel.lev;
            const qty = notional / price;
            return { price, margin, notional, qty };
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

          const totalFee2 = newNotional * fee * 2;
          const breakeven = isLong
            ? newAvg + totalFee2 / newQty
            : newAvg - totalFee2 / newQty;

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

    return {
      parsed, wb, cp, fee, exLiq,
      totalPnL, equity, totalMargin, freeMargin,
      mmActual, mmRate, liqDistPct,
      sel, dcaResult, revResult, closeResult, splitResult, availCalc,
    };
  }, [wallet, curPrice, feeRate, exLiqPrice, positions, selId, dcaMode, dcaEntries, revPrice, revTarget, targetAvail, closeRatio, closePrice, splitMode, splitTotal, splitPrices]);

  const selPos = positions.find((p) => p.id === selId);

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
            <div style={S.hdrDot} />
            <span style={S.hdrBadge}>CROSS MARGIN · FUTURES</span>
          </div>
          <h1 style={S.hdrTitle}>물타기 시뮬레이터</h1>
          <p style={S.hdrSub}>다중 포지션 · 평단가 · 청산가 · 역계산</p>
        </header>

        {/* ① ACCOUNT & MARKET */}
        <Sec label="계좌 & 시장" />
        <div style={S.grid2}>
          <Fld label="지갑 총 잔고 (USDT)">
            <Inp value={wallet} onChange={setWallet} ph="9120.57" />
          </Fld>
          <Fld label="현재가 ($)">
            <Inp value={curPrice} onChange={setCurPrice} ph="코인 현재 가격" />
          </Fld>
        </div>
        <div style={{ ...S.grid2, marginTop: 8 }}>
          <Fld label="거래소 강제 청산가 ($)">
            <Inp value={exLiqPrice} onChange={setExLiqPrice} ph="거래소 화면에서 확인" />
          </Fld>
          <Fld label="수수료율 (%)">
            <Inp value={feeRate} onChange={setFeeRate} ph="0.04" />
          </Fld>
        </div>

        {/* ② POSITIONS */}
        <Sec label="기존 포지션" />
        {positions.map((pos, idx) => (
          <PosCard key={pos.id} pos={pos} idx={idx}
            isSel={pos.id === selId}
            onSelect={() => selectPos(pos.id)}
            onUpdate={updPos}
            onRemove={() => rmPos(pos.id)}
            canRemove={positions.length > 1}
            cp={n(curPrice)} />
        ))}
        <button onClick={addPos} style={S.addBtn}>+ 포지션 추가</button>

        {/* ③ ACCOUNT SUMMARY */}
        {calc && n(curPrice) > 0 && (
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
                color={calc.freeMargin > 0 ? "#34d399" : "#f87171"} />
            </div>

            {/* Available amount target */}
            <div style={S.availBox}>
              <div style={S.availRow}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>목표 사용 가능 금액</div>
                  <Inp value={targetAvail} onChange={setTargetAvail} ph="확보 목표 USDT" />
                </div>
                <div style={{ flex: 1, paddingLeft: 12, display: "flex", alignItems: "flex-end" }}>
                  {calc.availCalc ? (
                    calc.availCalc.sufficient ? (
                      <div style={{ fontSize: 13, color: "#34d399", fontWeight: 600, paddingBottom: 10 }}>
                        ✓ 현재 충분
                      </div>
                    ) : calc.availCalc.impossible ? (
                      <div style={{ fontSize: 12, color: "#f87171", paddingBottom: 10 }}>
                        현재 포지션 구조에서 도달 불가
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
            {n(exLiqPrice) > 0 ? (
              <div style={S.liqBar}>
                <div style={S.liqBarInner}>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>강제 청산가</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                      ${fmt(n(exLiqPrice))}
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
          </>
        )}

        {/* ④ DCA SECTION */}
        {selId && selPos && (
          <>
            <Sec label={`물타기 — ${selPos.coin} ${selPos.dir === "long" ? "롱" : "숏"}`} accent />

            <div style={S.modeRow}>
              {[["sim", "시뮬레이션"], ["reverse", "목표 역계산"], ["close", "손절"]].map(([k, lb]) => (
                <button key={k} onClick={() => setDcaMode(k)} style={{
                  ...S.modeBtn,
                  background: dcaMode === k ? (k === "close" ? "#f8717115" : "#0ea5e915") : "transparent",
                  borderColor: dcaMode === k ? (k === "close" ? "#f8717144" : "#0ea5e944") : "#1e1e2e",
                  color: dcaMode === k ? (k === "close" ? "#f87171" : "#0ea5e9") : "#6b7280",
                }}>{lb}</button>
              ))}
            </div>

            {dcaMode === "sim" && (
              <>
                {/* Direct input — always visible */}
                {dcaEntries.map((dca, idx) => (
                  <div key={dca.id} style={S.dcaRow}>
                    <div style={S.dcaNum}>{idx + 1}</div>
                    <div style={{ flex: 1 }}>
                      <Inp value={dca.price} onChange={(v) => updDCA(dca.id, "price", v)} ph="진입 예정가 ($)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Inp value={dca.margin} onChange={(v) => updDCA(dca.id, "margin", v)} ph="추가 마진 (USDT)" />
                    </div>
                    {dcaEntries.length > 1 && (
                      <button onClick={() => rmDCA(dca.id)} style={S.rmSm}>×</button>
                    )}
                  </div>
                ))}
                <button onClick={addDCA} style={S.addBtn}>+ 물타기 추가</button>

                {/* Split helper — collapsible */}
                <button onClick={openSplitHelper} style={S.splitToggle}>
                  {splitMode ? "분할 도우미 접기 ▲" : "분할 도우미 열기 ▼"}
                </button>

                {splitMode && (
                  <div style={S.splitPanel}>
                    <Fld label="총 투입 마진 (USDT)">
                      <Inp value={splitTotal} onChange={setSplitTotal} ph="300" />
                    </Fld>

                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>물타기 가격</div>
                      {splitPrices.map((sp, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                          <div style={{ ...S.dcaNum, width: 20, height: 20, fontSize: 10 }}>{idx + 1}</div>
                          <div style={{ flex: 1 }}>
                            <input type="number" value={sp} placeholder={`가격 ${idx + 1}`}
                              onChange={(e) => updSplitPrice(idx, e.target.value)}
                              style={{ ...S.inp, fontSize: 12, padding: "7px 10px" }}
                              onFocus={(e) => (e.target.style.borderColor = "#0ea5e9")}
                              onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                          </div>
                          {splitPrices.length > 2 && (
                            <button onClick={() => rmSplitPrice(idx)} style={{ ...S.rmSm, width: 28, height: 32, fontSize: 14 }}>×</button>
                          )}
                        </div>
                      ))}
                      <button onClick={addSplitPrice} style={{ ...S.addBtn, marginTop: 2, fontSize: 11, padding: "6px 0" }}>+ 가격 추가</button>
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
                                  {n(exLiqPrice) > 0 && sr.afterLiq != null && (
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
                  <Inp value={revPrice} onChange={setRevPrice} ph="예: 2700" />
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
                    <Inp value={closePrice} onChange={setClosePrice} ph="현재가 기준" />
                  </Fld>
                </div>
              </>
            )}
          </>
        )}

        {!selId && (
          <div style={S.empty}>↑ 포지션을 선택하면 물타기를 시뮬레이션할 수 있습니다</div>
        )}

        {/* ⑤ RESULTS — Simulation */}
        {calc?.dcaResult && (() => {
          const r = calc.dcaResult;
          const isLong = calc.sel.dir === "long";
          return <ResultBlock r={r} isLong={isLong} cp={calc.cp} mode="sim" hasExLiq={n(exLiqPrice) > 0} />;
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
                  필요 마진: {fmt(rv.requiredMargin)} USDT
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
              <ResultBlock r={rv} isLong={isLong} cp={calc.cp} mode="reverse" hasExLiq={n(exLiqPrice) > 0} />
            </>
          );
        })()}

        {/* ⑤ RESULTS — Close (손절) */}
        {calc?.closeResult && (() => {
          const cr = calc.closeResult;
          const isLong = calc.sel.dir === "long";
          const hasExLiq = n(exLiqPrice) > 0;
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
  const fee = r.totalFee;
  const calcExit = (targetPnL) => {
    // targetPnL is the desired realized PnL in USDT (after fees)
    // exitPrice where: sign * (exitPrice - avg) * qty - fee = targetPnL
    // Long: (exitPrice - avg) * qty = targetPnL + fee → exitPrice = avg + (targetPnL + fee) / qty
    // Short: (avg - exitPrice) * qty = targetPnL + fee → exitPrice = avg - (targetPnL + fee) / qty
    if (a.qty <= 0) return null;
    const exitPrice = isLong
      ? a.avg + (targetPnL + fee) / a.qty
      : a.avg - (targetPnL + fee) / a.qty;
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
        <SL label="왕복 수수료" value={`${fmt(r.totalFee)} USDT`} />
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
function Sec({ label, accent }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase",
      color: accent ? "#0ea5e9" : "#4b5563", fontFamily: "'DM Sans'",
      margin: "28px 0 10px", display: "flex", alignItems: "center", gap: 8,
    }}>
      {accent && <div style={{ width: 3, height: 14, background: "#0ea5e9", borderRadius: 2 }} />}
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

function PosCard({ pos, idx, isSel, onSelect, onUpdate, onRemove, canRemove, cp }) {
  const dirC = pos.dir === "long" ? "#34d399" : "#f87171";
  const ep = n(pos.entryPrice), mg = n(pos.margin), lev = n(pos.leverage);
  const notional = mg * lev;
  const qty = ep > 0 ? notional / ep : 0;
  const sign = pos.dir === "long" ? 1 : -1;
  const pnl = cp > 0 && qty > 0 ? sign * (cp - ep) * qty : null;
  const roe = pnl != null && mg > 0 ? (pnl / mg) * 100 : null;

  return (
    <div style={{ ...S.card, borderColor: isSel ? "#0ea5e9" : "#1e1e2e", background: isSel ? "#060a14" : "#08080f" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#4b5563" }}>#{idx + 1}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: dirC, padding: "2px 8px", borderRadius: 4,
            background: pos.dir === "long" ? "#34d39912" : "#f8717112",
            border: `1px solid ${dirC}33`,
          }}>{pos.dir === "long" ? "LONG" : "SHORT"}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onSelect} style={{
            ...S.miniBtn,
            background: isSel ? "#0ea5e915" : "transparent",
            borderColor: isSel ? "#0ea5e944" : "#1e1e2e",
            color: isSel ? "#0ea5e9" : "#6b7280",
          }}>{isSel ? "✓ 선택됨" : "물타기"}</button>
          {canRemove && <button onClick={onRemove} style={{ ...S.miniBtn, color: "#f87171", borderColor: "#1e1e2e" }}>삭제</button>}
        </div>
      </div>
      <div style={S.grid3}>
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
        <Fld label="코인">
          <select value={pos.coin} onChange={(e) => onUpdate(pos.id, "coin", e.target.value)} style={S.sel}>
            {COINS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Fld>
        <Fld label="레버리지">
          <select value={pos.leverage} onChange={(e) => onUpdate(pos.id, "leverage", Number(e.target.value))} style={S.sel}>
            {LEV_PRESETS.map((l) => <option key={l} value={l}>x{l}</option>)}
          </select>
        </Fld>
      </div>
      <div style={{ ...S.grid2, marginTop: 8 }}>
        <Fld label="오픈 균일가 ($)">
          <Inp value={pos.entryPrice} onChange={(v) => onUpdate(pos.id, "entryPrice", v)} ph="1952.15" />
        </Fld>
        <Fld label="마진 (USDT)">
          <Inp value={pos.margin} onChange={(v) => onUpdate(pos.id, "margin", v)} ph="188.28" />
        </Fld>
      </div>
      {ep > 0 && mg > 0 && pnl != null && (
        <div style={S.autoRow}>
          <span style={{ color: pnl >= 0 ? "#34d399" : "#f87171" }}>
            PnL: {fmtS(pnl)} ({fmtS(roe)}%)
          </span>
        </div>
      )}
    </div>
  );
}

function SumCard({ label, value, color }) {
  return (
    <div style={S.sumCard}>
      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'IBM Plex Mono'" }}>{value}</div>
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
