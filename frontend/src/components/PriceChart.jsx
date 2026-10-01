import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { istDayHM, price as fmtPrice } from '../lib/format.js';
import EChart, { C } from './EChart.jsx';

/** Strategy-timeframe candles for one instrument with channel, EMA and entry/stop/target overlays. */
export default function PriceChart({ instId, position }) {
  const { data } = useQuery({
    queryKey: ['candles', instId],
    queryFn: () => api.get(`/candles/${encodeURIComponent(instId)}`),
    refetchInterval: 3000,
    enabled: Boolean(instId),
  });

  const option = useMemo(() => {
    const bars = data?.candles || [];
    const cats = bars.map((b) => istDayHM(b.time));
    const lines = [];
    if (data?.channel?.high) {
      lines.push({ yAxis: data.channel.high, name: 'channel high', lineStyle: { color: C.blue, type: 'dashed' } });
      lines.push({ yAxis: data.channel.low, name: 'channel low', lineStyle: { color: C.blue, type: 'dashed' } });
    }
    if (data?.channel?.ema) lines.push({ yAxis: data.channel.ema, name: 'EMA', lineStyle: { color: C.accent, type: 'dotted' } });
    if (position?.entryPrice) {
      lines.push({ yAxis: position.entryPrice, name: 'entry', lineStyle: { color: C.text } });
      lines.push({ yAxis: position.stop, name: 'stop', lineStyle: { color: C.down } });
      lines.push({ yAxis: position.target, name: 'target', lineStyle: { color: C.up } });
    }
    const first = bars[0]?.time ?? 0;
    const tfMs = (data?.timeframe || 15) * 60_000;
    const cat = (t) => istDayHM(Math.floor(new Date(t).getTime() / tfMs) * tfMs);
    const points = [];
    for (const t of data?.trades || []) {
      if (t.entryAt && t.entryPrice && new Date(t.entryAt) >= first) points.push({ coord: [cat(t.entryAt), t.entryPrice], value: t.side === 'BUY' ? 'L' : 'S', itemStyle: { color: C.accent } });
      if (t.exitAt && t.exitPrice && new Date(t.exitAt) >= first) points.push({ coord: [cat(t.exitAt), t.exitPrice], value: 'X', itemStyle: { color: t.netPnl >= 0 ? C.up : C.down } });
    }
    return {
      animation: false,
      grid: { left: 8, right: 76, top: 16, bottom: 28, containLabel: false },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: '#0b1511', borderColor: '#1f3a2f', textStyle: { color: '#d5efe4', fontFamily: 'JetBrains Mono', fontSize: 11 } },
      xAxis: { type: 'category', data: cats, boundaryGap: true, axisLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.axis, fontSize: 10 }, splitLine: { show: false } },
      yAxis: { scale: true, position: 'right', axisLabel: { color: C.axis, fontSize: 10, fontFamily: 'JetBrains Mono', formatter: (v) => fmtPrice(v) }, splitLine: { lineStyle: { color: C.grid } } },
      dataZoom: [{ type: 'inside', start: bars.length > 120 ? 100 - (120 / bars.length) * 100 : 0, end: 100 }],
      series: [
        {
          type: 'candlestick',
          name: instId,
          data: bars.map((b) => [b.open, b.close, b.low, b.high]),
          itemStyle: { color: C.up, color0: C.down, borderColor: C.up, borderColor0: C.down },
          markLine: { symbol: 'none', label: { position: 'insideStartTop', color: C.text, fontSize: 10, formatter: (p) => `${p.name} ${fmtPrice(p.value)}` }, data: lines },
          markPoint: { symbol: 'pin', symbolSize: 34, label: { fontSize: 10, color: '#04140d', fontWeight: 700 }, data: points },
        },
      ],
    };
  }, [data, position, instId]);

  if (!data?.candles?.length) return <div className="empty" style={{ height: 360 }}>Loading candles…</div>;
  return <EChart option={option} height={360} />;
}
