import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export default function EChart({ option, height = 300, className = '' }) {
  const ref = useRef(null);
  const chart = useRef(null);
  useEffect(() => {
    chart.current = echarts.init(ref.current, null, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);
  return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}

export const C = {
  up: '#2ee59d',
  down: '#ff5c6c',
  grid: 'rgba(120,160,140,0.10)',
  axis: '#5f7a6f',
  text: '#9db8ad',
  accent: '#f5a524',
  blue: '#5aa9ff',
};
