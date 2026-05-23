import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Square, RefreshCcw, Upload, ArrowLeftCircle, Loader2 } from 'lucide-react';

/**
 * WaitingSimulatorV2 – ABC Segment loop-waiting video simulator
 *
 * Approach: extract video frames into ImageBitmap array during prep,
 * then drive a <canvas> at any direction/speed.
 *
 * Segments:
 *   A: 0 -> t1
 *   B: t1 -> t2
 *   C: t2 -> duration
 *
 * Playback Logic 2 (Seamless transitions):
 *   - INTRO: A (0 -> t1)
 *   - LOOP: 
 *       At t1: Must play B (t1 -> t2)
 *       At t2: Randomly choose C (t2 -> duration) or -B (t2 -> t1)
 *       At duration: Must play -C (duration -> t2)
 *   - ENDING: 
 *       From current position, reverse all the way back to 0.
 *       e.g., if at C, play back to t2, then -B to t1, then -A to 0.
 */

const TARGET_FPS = 30;
const FRAME_INTERVAL = 1 / TARGET_FPS;

export default function WaitingSimulatorV2() {
  const [videoSrc, setVideoSrc] = useState(null);
  const [duration, setDuration] = useState(0);
  const [t1, setT1] = useState(3);
  const [t2, setT2] = useState(5);
  const [exitTime, setExitTime] = useState(4);
  const [speed, setSpeed] = useState(1);
  const [isForceEnded, setIsForceEnded] = useState(false);

  const [phase, setPhase] = useState('idle'); // idle | preparing | intro | loop | ending | ended
  const [currentTime, setCurrentTime] = useState(0);
  const [segments, setSegments] = useState([]);
  const [activeSegment, setActiveSegment] = useState(null);
  const [prepProgress, setPrepProgress] = useState(0);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const framesRef = useRef([]); // ImageBitmap[]
  const animRef = useRef(null);
  const phaseRef = useRef('idle');
  const activeSegmentRef = useRef(null);
  const currentTimeRef = useRef(0);
  const t1Ref = useRef(t1);
  const t2Ref = useRef(t2);
  const durationRef = useRef(duration);
  const speedRef = useRef(speed);

  // Keep refs in sync with state
  useEffect(() => { t1Ref.current = t1; }, [t1]);
  useEffect(() => { t2Ref.current = t2; }, [t2]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const updateCurrentTime = useCallback((t) => {
    currentTimeRef.current = t;
    setCurrentTime(t);
  }, []);

  const addSegment = useCallback((from, to) => {
    setSegments(prev => [...prev, { from, to, id: Date.now() + Math.random() }]);
  }, []);

  const timeToFrame = useCallback((t) => {
    return Math.round(t * TARGET_FPS);
  }, []);

  const frameToTime = useCallback((f) => {
    return f * FRAME_INTERVAL;
  }, []);

  // ─── Frame Extraction ───────────────────────────────────
  const extractFrames = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    setPhase('preparing');
    phaseRef.current = 'preparing';
    setPrepProgress(0);

    framesRef.current.forEach(f => f.close?.());
    framesRef.current = [];

    const totalFrames = Math.ceil(video.duration * TARGET_FPS);
    const offscreen = document.createElement('canvas');
    offscreen.width = video.videoWidth;
    offscreen.height = video.videoHeight;
    const ctx = offscreen.getContext('2d');

    const frames = [];

    for (let i = 0; i <= totalFrames; i++) {
      const seekTime = Math.min(i * FRAME_INTERVAL, video.duration);
      video.currentTime = seekTime;

      await new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        setTimeout(resolve, 300);
      });

      ctx.drawImage(video, 0, 0);
      const bitmap = await createImageBitmap(offscreen);
      frames.push(bitmap);

      setPrepProgress(Math.round(((i + 1) / (totalFrames + 1)) * 100));
    }

    framesRef.current = frames;
    video.currentTime = 0;

    return frames;
  }, []);

  // ─── Canvas Rendering ──────────────────────────────────
  const drawFrame = useCallback((frameIndex) => {
    const canvas = canvasRef.current;
    const frames = framesRef.current;
    if (!canvas || !frames.length) return;

    const idx = Math.max(0, Math.min(frameIndex, frames.length - 1));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frames[idx], 0, 0, canvas.width, canvas.height);
  }, []);

  // ─── Canvas Playback Engine ─────────────────────────────
  const startCanvasPlayback = useCallback((fromTime, toTime, onComplete, forceSpeed = null) => {
    if (animRef.current) cancelAnimationFrame(animRef.current);

    // Randomize speed for this segment (0.7x – 1.0x) or use forced speed
    const segSpeed = forceSpeed !== null ? forceSpeed : (0.7 + Math.random() * 0.3);
    speedRef.current = segSpeed;
    setSpeed(segSpeed);

    const fromFrame = timeToFrame(fromTime);
    const toFrame = timeToFrame(toTime);
    const direction = toFrame >= fromFrame ? 1 : -1;
    let currentFrame = fromFrame;

    const segInfo = { from: fromTime, to: toTime, direction: direction > 0 ? 'forward' : 'reverse' };
    setActiveSegment(segInfo);
    activeSegmentRef.current = segInfo;

    let lastTimestamp = null;
    let accumulator = 0;

    const step = (timestamp) => {
      if (phaseRef.current === 'idle') return;

      if (lastTimestamp === null) lastTimestamp = timestamp;
      const dt = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      
      accumulator += Math.min(dt, 0.1) * speedRef.current;

      let advanced = false;
      while (accumulator >= FRAME_INTERVAL) {
        accumulator -= FRAME_INTERVAL;
        currentFrame += direction;
        advanced = true;

        if ((direction > 0 && currentFrame >= toFrame) ||
            (direction < 0 && currentFrame <= toFrame)) {
          currentFrame = toFrame;
          drawFrame(currentFrame);
          updateCurrentTime(frameToTime(currentFrame));
          if (onComplete) onComplete();
          return;
        }
      }

      if (advanced) {
        drawFrame(currentFrame);
        updateCurrentTime(frameToTime(currentFrame));
      }

      animRef.current = requestAnimationFrame(step);
    };

    drawFrame(currentFrame);
    updateCurrentTime(frameToTime(currentFrame));
    animRef.current = requestAnimationFrame(step);
  }, [drawFrame, timeToFrame, frameToTime, updateCurrentTime]);

  // ─── Phase Transition Logic ─────────────────────────────
  const onSegmentDone = useCallback((fromTime, toTime) => {
    const currentPhase = phaseRef.current;
    const pos = toTime;
    
    // Safety check - if ending reaches 0, we're fully done
    if ((currentPhase === 'ending' || currentPhase === 'jump_out') && pos <= 0.05) {
      addSegment(fromTime, 0);
      phaseRef.current = 'ended';
      setPhase('ended');
      setActiveSegment(null);
      activeSegmentRef.current = null;
      if (currentPhase === 'jump_out') setIsForceEnded(true);
      return;
    }

    if (currentPhase !== 'ending' && currentPhase !== 'jump_out') {
      addSegment(fromTime, toTime);
    }

    const t1_val = t1Ref.current;
    const t2_val = t2Ref.current;
    const dur = framesRef.current.length * FRAME_INTERVAL;

    if (currentPhase === 'intro') {
      phaseRef.current = 'loop';
      setPhase('loop');
      // Must play B (t1 -> t2)
      startCanvasPlayback(t1_val, t2_val, () => onSegmentDone(t1_val, t2_val));

    } else if (currentPhase === 'loop') {
      if (Math.abs(pos - t1_val) < 0.05) {
        // At t1, must play B (t1 -> t2)
        startCanvasPlayback(t1_val, t2_val, () => onSegmentDone(t1_val, t2_val));
      } else if (Math.abs(pos - t2_val) < 0.05) {
        // At t2, randomly choose C (t2 -> dur) or -B (t2 -> t1)
        const playC = Math.random() > 0.5;
        if (playC) {
          startCanvasPlayback(t2_val, dur, () => onSegmentDone(t2_val, dur));
        } else {
          startCanvasPlayback(t2_val, t1_val, () => onSegmentDone(t2_val, t1_val));
        }
      } else if (Math.abs(pos - dur) < 0.05) {
        // At dur, must play -C (dur -> t2)
        startCanvasPlayback(dur, t2_val, () => onSegmentDone(dur, t2_val));
      }
    } else if (currentPhase === 'ending' || currentPhase === 'jump_out') {
      const remaining = pos;
      const targetSpeed = currentPhase === 'jump_out' ? Math.max(1, 1 + (remaining - 1) / 3) : null;

      if (Math.abs(pos - t2_val) < 0.05) {
        addSegment(fromTime, t2_val);
        startCanvasPlayback(t2_val, t1_val, () => onSegmentDone(t2_val, t1_val), targetSpeed);
      } else if (Math.abs(pos - t1_val) < 0.05) {
        addSegment(fromTime, t1_val);
        startCanvasPlayback(t1_val, 0, () => onSegmentDone(t1_val, 0), targetSpeed);
      }
    }
  }, [addSegment, startCanvasPlayback]);

  // ─── Actions ────────────────────────────────────────────
  const handleVideoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      framesRef.current.forEach(f => f.close?.());
      framesRef.current = [];

      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setPhase('idle');
      phaseRef.current = 'idle';
      setCurrentTime(0);
      currentTimeRef.current = 0;
      setSegments([]);
      setActiveSegment(null);
      activeSegmentRef.current = null;
    }
  };

  const onLoadedMetadata = () => {
    if (videoRef.current) {
      const d = videoRef.current.duration;
      setDuration(d);
      
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
      }
    }
  };

  const startSimulation = async () => {
    const video = videoRef.current;
    if (!video || duration <= 0) return;

    stopAll();
    setSegments([]);
    setActiveSegment(null);
    activeSegmentRef.current = null;
    setIsForceEnded(false);
    updateCurrentTime(0);

    if (framesRef.current.length === 0) {
      await extractFrames();
    }

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    phaseRef.current = 'intro';
    setPhase('intro');

    startCanvasPlayback(0, t1, () => onSegmentDone(0, t1));
  };

  const endSimulation = () => {
    if (phaseRef.current === 'loop') {
      if (animRef.current) cancelAnimationFrame(animRef.current);

      const curSeg = activeSegmentRef.current;
      const approxTime = currentTimeRef.current;

      if (curSeg) {
        addSegment(curSeg.from, approxTime);
      }

      phaseRef.current = 'ending';
      setPhase('ending');

      // To ensure seamless reverse, we play backwards from current time to the nearest boundary below
      if (approxTime > t2Ref.current) {
        startCanvasPlayback(approxTime, t2Ref.current, () => onSegmentDone(approxTime, t2Ref.current));
      } else if (approxTime > t1Ref.current) {
        startCanvasPlayback(approxTime, t1Ref.current, () => onSegmentDone(approxTime, t1Ref.current));
      } else {
        startCanvasPlayback(approxTime, 0, () => onSegmentDone(approxTime, 0));
      }
    }
  };

  const stopAll = () => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    phaseRef.current = 'idle';
    setPhase('idle');
    setActiveSegment(null);
    activeSegmentRef.current = null;
  };

  const forceExitSimulation = () => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'preparing' || phaseRef.current === 'ended') return;
    if (animRef.current) cancelAnimationFrame(animRef.current);

    const approxTime = currentTimeRef.current;
    
    const curSeg = activeSegmentRef.current;
    if (curSeg) {
      addSegment(curSeg.from, approxTime);
    }

    if (approxTime > exitTime) {
      phaseRef.current = 'ended';
      setPhase('ended');
      setActiveSegment(null);
      activeSegmentRef.current = null;
      setIsForceEnded(true);
    } else {
      phaseRef.current = 'jump_out';
      setPhase('jump_out');
      
      const remaining = approxTime;
      const targetSpeed = Math.max(1, 1 + (remaining - 1) / 3); 
      
      if (approxTime > t2Ref.current) {
        startCanvasPlayback(approxTime, t2Ref.current, () => onSegmentDone(approxTime, t2Ref.current), targetSpeed);
      } else if (approxTime > t1Ref.current) {
        startCanvasPlayback(approxTime, t1Ref.current, () => onSegmentDone(approxTime, t1Ref.current), targetSpeed);
      } else {
        startCanvasPlayback(approxTime, 0, () => onSegmentDone(approxTime, 0), targetSpeed);
      }
    }
  };

  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      framesRef.current.forEach(f => f.close?.());
    };
  }, []);

  // ─── Rendering Helpers ──────────────────────────────────
  const phaseColors = {
    intro: { text: 'text-indigo-600' },
    loop: { text: 'text-emerald-600' },
    ending: { text: 'text-amber-600' },
    jump_out: { text: 'text-rose-600' },
  };

  const getSegmentNameByTime = (from, to) => {
    const min = Math.min(from, to);
    const max = Math.max(from, to);
    if (max <= t1 + 0.1) return 'A';
    if (min >= t1 - 0.1 && max <= t2 + 0.1) return 'B';
    if (min >= t2 - 0.1) return 'C';
    return '?';
  };

  const effectiveDuration = duration || 1;

  return (
    <div className="h-full flex gap-6 p-6 bg-white overflow-hidden min-h-0">
      <div className="w-80 flex-shrink-0 flex flex-col gap-4 p-5 bg-slate-50 rounded-xl border border-slate-200 overflow-y-auto min-h-0">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">上传等待态视频</label>
            <label className="flex items-center justify-center w-full h-12 px-4 border-2 border-dashed border-indigo-300 rounded-lg text-indigo-600 hover:bg-indigo-50 hover:border-indigo-400 cursor-pointer transition-colors">
              <Upload className="w-4 h-4 mr-2" />
              <span className="text-sm font-medium">选择视频文件</span>
              <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
            </label>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-2">t1 (A结束)</label>
              <input
                type="number"
                min="0"
                max={t2}
                step="0.1"
                value={t1}
                onChange={(e) => setT1(parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-2">t2 (B结束)</label>
              <input
                type="number"
                min={t1}
                max={duration}
                step="0.1"
                value={t2}
                onChange={(e) => setT2(parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            A段: 0~t1, B段: t1~t2, C段: t2~结束
          </p>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">跳出时间 (秒)</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={exitTime}
              onChange={(e) => setExitTime(parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-slate-500 mt-1">控制点击"点击结束"时的行为</p>
          </div>

          <div className="pt-4 border-t border-slate-200 flex flex-col gap-2">
            <button
              onClick={startSimulation}
              disabled={!videoSrc || duration <= 0 || (phase !== 'idle' && phase !== 'ended')}
              className="flex items-center justify-center w-full py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {phase === 'preparing' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  提取帧中... {prepProgress}%
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  开始模拟
                </>
              )}
            </button>
            <button
              onClick={endSimulation}
              disabled={phase !== 'loop'}
              className="flex items-center justify-center w-full py-2.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowLeftCircle className="w-4 h-4 mr-2" />
              平滑回退至0
            </button>
            <button
              onClick={forceExitSimulation}
              disabled={phase === 'idle' || phase === 'preparing' || phase === 'ended'}
              className="flex items-center justify-center w-full py-2.5 bg-rose-500 text-white rounded-lg text-sm font-medium hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Square className="w-4 h-4 mr-2" />
              点击结束 (立刻/加速)
            </button>
            <button
              onClick={stopAll}
              disabled={phase === 'idle' || phase === 'ended' || phase === 'preparing'}
              className="flex items-center justify-center w-full py-2.5 bg-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Square className="w-4 h-4 mr-2" />
              强制停止
            </button>
          </div>

          {phase === 'preparing' && (
            <div className="mt-2">
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-200"
                  style={{ width: `${prepProgress}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-auto pt-4">
            <div className="text-sm text-slate-600 flex justify-between mb-1">
              <span>当前状态:</span>
              <span className={`font-semibold ${phaseColors[phase]?.text || 'text-slate-500'}`}>
                {phase === 'idle' && '空闲'}
                {phase === 'preparing' && '准备中'}
                {phase === 'intro' && '过渡入场 (0 → t1)'}
                {phase === 'loop' && 'ABC 组合循环'}
                {phase === 'ending' && '结束退场 (→ 0)'}
                {phase === 'jump_out' && '加速跳出中...'}
                {phase === 'ended' && '已结束'}
              </span>
            </div>
            <div className="text-sm text-slate-600 flex justify-between mb-1">
              <span>当前时间:</span>
              <span className="font-mono">{currentTime.toFixed(2)}s</span>
            </div>
            {activeSegment && (
              <>
                <div className="text-sm text-slate-600 flex justify-between">
                  <span>当前段:</span>
                  <span className="font-mono text-xs font-semibold text-indigo-600">
                    {activeSegment.direction === 'reverse' ? '-' : ''}{getSegmentNameByTime(activeSegment.from, activeSegment.to)} 
                    <span className="text-slate-400 font-normal ml-1">
                      ({activeSegment.from.toFixed(1)}s {activeSegment.direction === 'forward' ? '→' : '←'} {activeSegment.to.toFixed(1)}s)
                    </span>
                  </span>
                </div>
                <div className="text-sm text-slate-600 flex justify-between">
                  <span>当前速度:</span>
                  <span className="font-mono text-emerald-600">{speed.toFixed(2)}x</span>
                </div>
              </>
            )}
            <div className="text-sm text-slate-600 flex justify-between mt-1">
              <span>已播放段:</span>
              <span className="font-mono">{segments.length}</span>
            </div>
          </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 min-w-0 min-h-0">
        <video
          ref={videoRef}
            src={videoSrc || undefined}
            className="hidden"
            onLoadedMetadata={onLoadedMetadata}
            muted
            playsInline
            preload="auto"
          />

          <div className="flex-1 relative bg-black rounded-xl overflow-hidden shadow-sm border border-slate-200 min-h-0 flex items-center justify-center">
            {videoSrc ? (
              <canvas
                ref={canvasRef}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="text-slate-400 text-sm">请先上传视频</div>
            )}

            {phase === 'preparing' && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-10 h-10 text-white animate-spin" />
                <span className="text-white text-sm">提取帧中 {prepProgress}%</span>
              </div>
            )}

            {isForceEnded && phase === 'ended' && (
              <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 animate-in fade-in duration-300">
                <span className="text-white text-3xl font-bold tracking-widest">播放结束</span>
              </div>
            )}
          </div>

          {duration > 0 && (
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex-shrink-0 flex flex-col h-56">
              <div className="flex justify-between text-xs text-slate-500 font-mono mb-2 flex-shrink-0">
                <span>0.00s</span>
                <span>t1={t1.toFixed(1)}s</span>
                <span>t2={t2.toFixed(1)}s</span>
                <span>{duration.toFixed(2)}s</span>
              </div>

              <div className="relative h-8 bg-slate-200 rounded-full overflow-hidden mb-3 flex-shrink-0">
                {/* A 段 */}
                <div
                  className="absolute top-0 bottom-0 bg-indigo-100/80 border-r-2 border-indigo-400"
                  style={{ width: `${(t1 / effectiveDuration) * 100}%` }}
                >
                  <span className="absolute right-1 top-1.5 text-[10px] text-indigo-600 font-semibold">A 段</span>
                </div>
                {/* B 段 */}
                <div
                  className="absolute top-0 bottom-0 bg-emerald-100/80 border-r-2 border-emerald-400"
                  style={{ left: `${(t1 / effectiveDuration) * 100}%`, width: `${((t2 - t1) / effectiveDuration) * 100}%` }}
                >
                  <span className="absolute left-2 top-1.5 text-[10px] text-emerald-600 font-semibold">B 段</span>
                </div>
                {/* C 段 */}
                <div
                  className="absolute top-0 bottom-0 bg-amber-100/80"
                  style={{ left: `${(t2 / effectiveDuration) * 100}%`, right: 0 }}
                >
                  <span className="absolute left-2 top-1.5 text-[10px] text-amber-600 font-semibold">C 段</span>
                </div>

                <div
                  className="absolute top-0 bottom-0 w-1 bg-rose-500 z-20 transition-all duration-75"
                  style={{ left: `${(currentTime / effectiveDuration) * 100}%` }}
                >
                  <div className="absolute -top-5 left-1/2 -translate-x-1/2 bg-rose-500 text-white text-[9px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap">
                    {currentTime.toFixed(1)}s
                  </div>
                </div>
              </div>

              <div className="space-y-1 overflow-y-auto min-h-0 flex-1">
                <div className="text-xs text-slate-500 font-medium mb-1 sticky top-0 bg-slate-50 py-1 z-10">播放历史:</div>
                {segments.length === 0 && !activeSegment && (
                  <div className="text-xs text-slate-400 italic">等待开始...</div>
                )}
                {segments.map((seg, i) => {
                  const minPos = Math.min(seg.from, seg.to);
                  const maxPos = Math.max(seg.from, seg.to);
                  const leftPct = (minPos / effectiveDuration) * 100;
                  const widthPct = ((maxPos - minPos) / effectiveDuration) * 100;
                  const isReverse = seg.to < seg.from;
                  const segName = getSegmentNameByTime(seg.from, seg.to);

                  return (
                    <div key={seg.id} className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400 w-4 text-right flex-shrink-0">{i + 1}</span>
                      <div className="relative h-3 flex-1 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`absolute top-0 bottom-0 rounded-full ${
                            segName === 'A' ? 'bg-indigo-400' :
                            segName === 'B' ? 'bg-emerald-400' : 'bg-amber-400'
                          } opacity-70`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${Math.max(widthPct, 0.5)}%`
                          }}
                        />
                      </div>
                      <span className="text-[10px] font-bold text-slate-600 w-6 text-center">
                        {isReverse ? '-' : ''}{segName}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono w-24 text-right flex-shrink-0">
                        {seg.from.toFixed(1)}s {isReverse ? '←' : '→'} {seg.to.toFixed(1)}s
                      </span>
                    </div>
                  );
                })}

                {activeSegment && phase !== 'idle' && phase !== 'ended' && phase !== 'preparing' && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 w-4 text-right flex-shrink-0">▶</span>
                    <div className="relative h-3 flex-1 bg-slate-100 rounded-full overflow-hidden">
                      {(() => {
                        const minPos = Math.min(activeSegment.from, currentTime);
                        const maxPos = Math.max(activeSegment.from, currentTime);
                        const leftPct = (minPos / effectiveDuration) * 100;
                        const widthPct = ((maxPos - minPos) / effectiveDuration) * 100;
                        const segName = getSegmentNameByTime(activeSegment.from, activeSegment.to);
                        
                        return (
                          <div
                            className={`absolute top-0 bottom-0 rounded-full ${
                              segName === 'A' ? 'bg-indigo-500' :
                              segName === 'B' ? 'bg-emerald-500' : 'bg-amber-500'
                            } animate-pulse`}
                            style={{
                              left: `${leftPct}%`,
                              width: `${Math.max(widthPct, 0.5)}%`
                            }}
                          />
                        );
                      })()}
                    </div>
                    <span className="text-[10px] font-bold text-slate-800 w-6 text-center">
                      {activeSegment.direction === 'reverse' ? '-' : ''}{getSegmentNameByTime(activeSegment.from, activeSegment.to)}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono w-24 text-right flex-shrink-0">
                      {activeSegment.from.toFixed(1)}s {activeSegment.direction === 'forward' ? '→' : '←'} {activeSegment.to.toFixed(1)}s
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
  );
}
