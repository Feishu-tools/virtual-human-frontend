import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MessageCircle, MessageSquare, Play, Pause, Download, Loader2, Settings, Film, Plus, X } from 'lucide-react';
import useStore from '../store/useStore';
import { exportCompositeFFmpeg, cutVideoSegment } from '../utils/ffmpegExport';
import { getExportNodeClipUrl } from '../config/api';

/**
 * 合成视频播放器（支持多交互节点）
 *
 * 播放原视频 → 到达交互时间点暂停 → 在裁剪位置叠加播放生成视频 → 结束后恢复原视频 → 继续到下一节点
 *
 * 等待视频播放逻辑（单段视频，2s处分割）：
 *   wait1正放(0→2s) → wait2正放(2s→end) → wait2倒放(end→2s)
 *   → 循环(wait2正放 → wait2倒放) → 点击交互后：
 *   → 播完当前wait2倒放 → wait1倒放(2s→0) → 接入交互视频
 */
const WAIT_SPLIT_TIME = 2;

const VideoPlayer = () => {
  const videoSrc = useStore((state) => state.videoSrc);
  const nodes = useStore((state) => state.nodes);
  const globalCropArea = useStore((state) => state.globalCropArea);
  const globalVideoNaturalSize = useStore((state) => state.globalVideoNaturalSize);
  const addNode = useStore((state) => state.addNode);
  const removeNode = useStore((state) => state.removeNode);
  const setIsVideoPlaying = useStore((state) => state.setIsVideoPlaying);
  const registerVideoToggle = useStore((state) => state.registerVideoToggle);
  const unregisterVideoToggle = useStore((state) => state.unregisterVideoToggle);
  const seekRequest = useStore((state) => state.seekRequest);
  const globalActiveNodeId = useStore((state) => state.activeNodeId);

  // 按时间排序的节点列表
  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => a.interactionTime - b.interactionTime),
    [nodes]
  );

  // 当前正在交互的节点 ID（overlay 激活时非空）
  const [activeNodeId, setActiveNodeId] = useState(null);

  // 已触发过的节点 ID 集合（scrub 回去会从中删除）
  const triggeredNodeIds = useRef(new Set());

  // 当前活跃节点
  const activeNode = useMemo(
    () => sortedNodes.find((n) => n.id === activeNodeId) ?? null,
    [sortedNodes, activeNodeId]
  );

  const setActiveNodeIdGlobal = useStore((state) => state.setActiveNodeId);

  // 从活跃节点解构视频资源（overlay 用）
  const waitingVideo = activeNode?.waitingVideo ?? null;
  const guidanceVideo = activeNode?.guidanceVideo ?? null;
  const feedbackVideo = activeNode?.feedbackVideo ?? null;
  const guidanceList = activeNode?.guidanceList ?? [];
  const feedbackList = activeNode?.feedbackList ?? [];
  const naturalSize = sortedNodes[0]?.videoNaturalSize ?? null;

  // ── 动态选定播放的视频 URL ──
  const [currentGuidanceUrl, setCurrentGuidanceUrl] = useState(null);
  const [currentFeedbackUrl, setCurrentFeedbackUrl] = useState(null);

  // 当活跃节点切换时，重置为默认选中的视频
  useEffect(() => {
    setCurrentGuidanceUrl(activeNode?.guidanceVideo ?? null);
    setCurrentFeedbackUrl(activeNode?.feedbackVideo ?? null);
  }, [activeNode]);

  // ── 状态 ──
  const [isPlaying, setIsPlaying] = useState(false);
  const [overlayMode, setOverlayMode] = useState(null); // null | 'waiting' | 'guidance' | 'feedback'
  const [overlayStyle, setOverlayStyle] = useState({});
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [exportMode, setExportMode] = useState('ffmpeg'); // 'ffmpeg' | 'recorder'
  const [waitLoopCount, setWaitLoopCount] = useState(1);

  /**
   * 等待视频播放阶段：
   *   'wait1_fwd'  - wait1 正放 (0 → 2s)
   *   'wait2_fwd'  - wait2 正放 (2s → end)
   *   'wait2_rev'  - wait2 倒放 (end → 2s)
   *   'wait1_rev'  - wait1 倒放 (2s → 0)，outro 阶段
   */
  const [waitingPhase, setWaitingPhase] = useState('wait1_fwd');

  // ── refs ──
  const containerRef = useRef(null);
  const originalVideoRef = useRef(null);
  const waitingVideoRef = useRef(null);
  const guidanceVideoRef = useRef(null);
  const feedbackVideoRef = useRef(null);
  const pendingOverlay = useRef(null);
  const queuedOverlay = useRef(null);
  const reverseRafRef = useRef(null);
  // 镜像 overlayMode / activeNodeId，供不能安全闭包的回调使用
  const overlayModeRef = useRef(null);
  const activeNodeIdRef = useRef(null);

  // ── 时间线相关状态 ──
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // ── 容器尺寸（用于计算缩放比例） ──
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 缩放比例：让内部 div（自然尺寸）完整地适应容器（contain 模式）
  const innerScale = useMemo(() => {
    if (!naturalSize?.width || !naturalSize?.height || !containerSize.width || !containerSize.height) return 1;
    return Math.min(containerSize.width / naturalSize.width, containerSize.height / naturalSize.height);
  }, [naturalSize, containerSize]);

  // 同步 ref 镜像
  useEffect(() => { overlayModeRef.current = overlayMode; }, [overlayMode]);
  useEffect(() => { activeNodeIdRef.current = activeNodeId; }, [activeNodeId]);

  // ═══════════════ 工具函数 ═══════════════
  const playVideoFromStart = (videoEl) => {
    if (!videoEl) return;
    if (videoEl.readyState > 0) {
      videoEl.currentTime = 0;
    }
    videoEl.play().catch(e => console.log('Video play interrupted or failed:', e));
  };

  const stopReverse = useCallback(() => {
    if (reverseRafRef.current) {
      clearInterval(reverseRafRef.current);
      reverseRafRef.current = null;
    }
  }, []);

  // nodes 被删除时，若活跃节点不再存在则清理 overlay
  useEffect(() => {
    if (activeNodeId && !sortedNodes.find((n) => n.id === activeNodeId)) {
      stopReverse();
      setOverlayMode(null);
      setActiveNodeId(null);
    }
  }, [sortedNodes, activeNodeId, stopReverse]);

  const startReverse = useCallback((video, targetTime, onComplete) => {
    stopReverse();
    if (!video) return;
    video.pause();

    const INTERVAL_MS = 33;
    const STEP_S = INTERVAL_MS / 1000;

    const intervalId = setInterval(() => {
      const newTime = video.currentTime - STEP_S;
      if (newTime <= targetTime) {
        video.currentTime = targetTime;
        clearInterval(intervalId);
        reverseRafRef.current = null;
        onComplete();
        return;
      }
      video.currentTime = newTime;
    }, INTERVAL_MS);

    reverseRafRef.current = intervalId;
  }, [stopReverse]);

  // 处理控制面板发起的跳转请求
  useEffect(() => {
    if (!seekRequest) return;
    const video = originalVideoRef.current;
    if (video) {
      const time = seekRequest.time;
      video.currentTime = time;
      setCurrentTime(time);

      // 同步所有节点的触发状态：目标时间之前的节点标记为已触发，之后的重置为未触发
      sortedNodes.forEach((n) => {
        if (n.interactionTime < time - 0.1) {
          triggeredNodeIds.current.add(n.id);
        } else {
          triggeredNodeIds.current.delete(n.id);
        }
      });

      // 如果当前活跃节点不在目标时间窗口内，中止 overlay
      const curActiveId = activeNodeIdRef.current;
      if (curActiveId) {
        const activeN = sortedNodes.find((n) => n.id === curActiveId);
        if (activeN && Math.abs(activeN.interactionTime - time) > 0.5) {
          stopReverse();
          setOverlayMode(null);
          setActiveNodeId(null);
        }
      }
    }
  }, [seekRequest, stopReverse, sortedNodes]);

  // ═══════════════ 添加节点 ═══════════════
  const handleAddNode = useCallback(() => {
    if (!globalCropArea) {
      alert('请先在左侧设置裁剪区域！');
      return;
    }
    const video = originalVideoRef.current;
    if (!video) return;

    video.pause();
    const time = video.currentTime;

    // 1. 参考 VideoFrameCropper.jsx，先将完整视频帧绘制到 canvas
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    // 2. 转为 jpeg dataURL，避免直接操作大尺寸 canvas 或直接裁切 video 导致的崩溃
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    // 3. 通过 Image 对象加载压缩后的图片再进行裁切
    const img = new Image();
    img.onload = () => {
      const cropped = document.createElement('canvas');
      cropped.width = globalCropArea.width;
      cropped.height = globalCropArea.height;
      cropped.getContext('2d').drawImage(
        img,
        globalCropArea.x, globalCropArea.y, globalCropArea.width, globalCropArea.height,
        0, 0, globalCropArea.width, globalCropArea.height
      );

      cropped.toBlob((blob) => {
        addNode({
          interactionTime: time,
          cropArea: globalCropArea,
          videoNaturalSize: globalVideoNaturalSize ?? { width: video.videoWidth, height: video.videoHeight },
          croppedImage: blob,
        });
      }, 'image/jpeg', 0.85);
    };
    img.src = dataUrl;
  }, [globalCropArea, globalVideoNaturalSize, addNode]);

  // ═══════════════ 叠加位置计算 ═══════════════
  const buildOverlayStyle = useCallback((node) => {
    const ca = node?.cropArea ?? globalCropArea;
    if (!ca) return {};
    return {
      position: 'absolute',
      left: `${ca.x-1}px`,
      top: `${ca.y}px`,
      width: `${ca.width}px`,
      height: `${ca.height}px`,
      zIndex: 20,
      overflow: 'hidden',
      backgroundColor: 'transparent',
      transform: 'translateZ(0)',
      willChange: 'transform, opacity',
    };
  }, [globalCropArea]);

  // ── 拖拽状态与事件 ──
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const positionRef = useRef({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragAmount = useRef(0);

  // overlayMode 中只暂停/恢复叠加视频；否则操作原视频
  const togglePlay = useCallback(() => {
    if (overlayMode) {
      const overlayRef =
        overlayMode === 'waiting' ? waitingVideoRef :
        overlayMode === 'guidance' ? guidanceVideoRef : feedbackVideoRef;
      const vid = overlayRef.current;
      if (!vid) return;
      if (vid.paused) vid.play().catch(console.error);
      else vid.pause();
      return;
    }
    const video = originalVideoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(console.error);
    else video.pause();
  }, [overlayMode]);

  // 与 video 元素的 play/pause 事件同步，同时更新全局 store
  const handleVideoPlay  = useCallback(() => { setIsPlaying(true);  setIsVideoPlaying(true);  }, [setIsVideoPlaying]);
  const handleVideoPause = useCallback(() => { setIsPlaying(false); setIsVideoPlaying(false); }, [setIsVideoPlaying]);

  // 将 togglePlay 注册到全局 store，供 App.jsx 的空格键调用
  useEffect(() => {
    registerVideoToggle(togglePlay);
    return () => unregisterVideoToggle();
  }, [togglePlay, registerVideoToggle, unregisterVideoToggle]);

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX - positionRef.current.x, y: e.clientY - positionRef.current.y };
    dragAmount.current = 0;
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isDragging.current) return;
    const newX = e.clientX - dragStart.current.x;
    const newY = e.clientY - dragStart.current.y;
    dragAmount.current += Math.abs(newX - positionRef.current.x) + Math.abs(newY - positionRef.current.y);
    positionRef.current = { x: newX, y: newY };
    setPosition({ x: newX, y: newY });
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (dragAmount.current < 5) {
      togglePlay();
    }
  }, [togglePlay]);

  const handleMouseLeave = useCallback(() => {
    isDragging.current = false;
  }, []);

  // ═══════════════ 等待视频播放状态机 ═══════════════

  const enterWait2Forward = useCallback(() => {
    stopReverse();
    const video = waitingVideoRef.current;
    if (!video) return;
    setWaitingPhase('wait2_fwd');
    video.currentTime = WAIT_SPLIT_TIME;
    video.play().catch(e => console.log('wait2_fwd play error:', e));
  }, [stopReverse]);

  const enterWait1Reverse = useCallback(() => {
    const video = waitingVideoRef.current;
    if (!video) return;
    setWaitingPhase('wait1_rev');
    video.currentTime = WAIT_SPLIT_TIME;

    startReverse(video, 0, () => {
      const nextMode = queuedOverlay.current;
      queuedOverlay.current = null;

      if (nextMode) {
        setOverlayMode(nextMode);
        const nextRef = nextMode === 'guidance' ? guidanceVideoRef.current : feedbackVideoRef.current;
        requestAnimationFrame(() => {
          playVideoFromStart(nextRef);
        });
      } else {
        setOverlayMode(null);
        const origVideo = originalVideoRef.current;
        if (origVideo) origVideo.play().catch(console.error);
      }
    });
  }, [startReverse]);

  const enterWait1ReverseRef = useRef(enterWait1Reverse);
  useEffect(() => { enterWait1ReverseRef.current = enterWait1Reverse; }, [enterWait1Reverse]);

  const enterWait2ForwardRef = useRef(enterWait2Forward);
  useEffect(() => { enterWait2ForwardRef.current = enterWait2Forward; }, [enterWait2Forward]);

  const enterWait2ReverseStable = useCallback(() => {
    const video = waitingVideoRef.current;
    if (!video) return;
    setWaitingPhase('wait2_rev');

    video.currentTime = video.duration - 0.05;

    startReverse(video, WAIT_SPLIT_TIME, () => {
      if (queuedOverlay.current) {
        enterWait1ReverseRef.current();
      } else {
        enterWait2ForwardRef.current();
      }
    });
  }, [startReverse]);

  const handleWaitingTimeUpdate = useCallback(() => {
    const video = waitingVideoRef.current;
    if (!video || overlayMode !== 'waiting') return;

    if (waitingPhase === 'wait1_fwd' && video.currentTime >= WAIT_SPLIT_TIME) {
      video.pause();
      enterWait2Forward();
    } else if (waitingPhase === 'wait2_fwd' && video.duration > 0 && video.currentTime >= video.duration - 0.05) {
      video.pause();
      enterWait2ReverseStable();
    }
  }, [overlayMode, waitingPhase, enterWait2Forward, enterWait2ReverseStable]);

  const startWaitingSequence = useCallback(() => {
    stopReverse();
    const video = waitingVideoRef.current;
    if (!video) return;
    setWaitingPhase('wait1_fwd');
    queuedOverlay.current = null;
    video.currentTime = 0;
    video.play().catch(e => console.log('wait1_fwd play error:', e));
  }, [stopReverse]);

  // ═══════════════ 单节点交互入口 ═══════════════
  /**
   * 进入指定节点的交互流程：
   *   - 有引导语 → 播引导语 → 结束后进等待
   *   - 无引导语 → 直接进等待
   *   - pendingOverlay 预置了模式时，优先使用预置模式
   */
  const enterNodeInteraction = useCallback((node) => {
    setOverlayStyle(buildOverlayStyle(node));
    setActiveNodeId(node.id);
    
    // 同步设置 URL，避免渲染延迟导致 ref 为空
    setCurrentGuidanceUrl(node.guidanceVideo ?? null);
    setCurrentFeedbackUrl(node.feedbackVideo ?? null);

    const pending = pendingOverlay.current;
    pendingOverlay.current = null;

    const hasGuidance =
      node.guidanceList?.some((g) => g.videoUrl) || !!node.guidanceVideo;
    const hasFeedback =
      node.feedbackList?.some((f) => f.videoUrl) || !!node.feedbackVideo;

    let mode;
    if (pending === 'feedback' && hasFeedback) mode = 'feedback';
    else if (pending === 'guidance' && hasGuidance) mode = 'guidance';
    else mode = hasGuidance ? 'guidance' : 'waiting';

    setOverlayMode(mode);

    // 延迟以确保 React 渲染完成并且 video 元素已挂载新 src
    setTimeout(() => {
      if (mode === 'guidance') playVideoFromStart(guidanceVideoRef.current);
      else if (mode === 'feedback') playVideoFromStart(feedbackVideoRef.current);
      else startWaitingSequence();
    }, 50);
  }, [buildOverlayStyle, startWaitingSequence]);

  // ═══════════════ 原视频 timeupdate → 扫描所有节点 ═══════════════
  const handleTimeUpdate = useCallback(() => {
    const video = originalVideoRef.current;
    if (!video) return;

    const t = video.currentTime;
    setCurrentTime(t);

    // overlay 正在播放时不检测节点触发
    if (overlayModeRef.current) return;

    // 找到第一个尚未触发、且当前时间已到达的节点
    const nodeToTrigger = sortedNodes.find(
      (n) =>
        !triggeredNodeIds.current.has(n.id) &&
        t >= n.interactionTime - 0.1 &&
        t <= n.interactionTime + 0.5
    );

    // 仅在视频播放状态下触发节点交互，避免拖拽进度条时意外卡住或播放
    if (nodeToTrigger && !video.paused) {
      triggeredNodeIds.current.add(nodeToTrigger.id);
      setActiveNodeIdGlobal(nodeToTrigger.id); // 同步到控制面板
      video.pause();
      enterNodeInteraction(nodeToTrigger);
    }
  }, [sortedNodes, enterNodeInteraction, setActiveNodeIdGlobal]);

  // ═══════════════ 叠加视频结束 → 恢复原视频或继续等待 ═══════════════
  const handleOverlayEnded = useCallback(() => {
    if (overlayMode === 'guidance') {
      // 引导语播完 → 进入等待循环
      setOverlayMode('waiting');
      requestAnimationFrame(() => startWaitingSequence());
    } else if (overlayMode === 'feedback') {
      // 反馈语播完 → 清除活跃节点，恢复原视频继续向后播放
      stopReverse();
      setOverlayMode(null);
      setActiveNodeId(null);
      // 注：此处不再调用 setActiveNodeIdGlobal(null) 清理控制面板的状态，以便用户在播完后仍可点击"导出当前"
      const video = originalVideoRef.current;
      if (video) video.play().catch(console.error);
    }
  }, [overlayMode, startWaitingSequence, stopReverse]);

  // ═══════════════ 触发交互（按钮点击） ═══════════════
  const triggerInteraction = useCallback((mode, selectedUrl = null) => {
    let finalUrl = selectedUrl;
    if (mode === 'guidance') {
      if (selectedUrl) setCurrentGuidanceUrl(selectedUrl);
      finalUrl = selectedUrl || currentGuidanceUrl;
    } else if (mode === 'feedback') {
      if (selectedUrl) setCurrentFeedbackUrl(selectedUrl);
      finalUrl = selectedUrl || currentFeedbackUrl;
    }

    if (!finalUrl) {
      alert('请先生成对应视频');
      return;
    }
    if (!videoSrc) {
      alert('请先上传视频并选取交互点');
      return;
    }

    if (overlayMode === 'waiting') {
      queuedOverlay.current = mode;

      if (waitingPhase === 'wait1_fwd') {
        const video = waitingVideoRef.current;
        if (video) {
          video.pause();
          enterWait2ReverseStable();
        }
      } else if (waitingPhase === 'wait2_fwd') {
        const video = waitingVideoRef.current;
        if (video) {
          video.pause();
          enterWait2ReverseStable();
        }
      }
      return;
    } else if (overlayMode !== null) {
      stopReverse();
      setOverlayMode(mode);
      setTimeout(() => {
        const ref = mode === 'guidance' ? guidanceVideoRef.current : feedbackVideoRef.current;
        playVideoFromStart(ref);
      }, 50);
      return;
    }

    // 没有叠加在播放，重置后从头播放原视频
    stopReverse();
    setOverlayMode(null);
    setActiveNodeId(null);
    triggeredNodeIds.current.clear();

    const video = originalVideoRef.current;
    if (!video) return;

    video.currentTime = 0;
    pendingOverlay.current = mode;

    video.play().catch(console.error);
  }, [currentGuidanceUrl, currentFeedbackUrl, videoSrc, overlayMode, waitingPhase, stopReverse, enterWait2ReverseStable]);

  // ═══════════════ 原视频事件 ═══════════════
  const handleOriginalEnded = () => {
    setIsPlaying(false);
    pendingOverlay.current = null;
    queuedOverlay.current = null;
  };

  const handleLoadedMetadata = () => {
    if (originalVideoRef.current) {
      setDuration(originalVideoRef.current.duration);
    }
  };

  const handleTimelineChange = (e) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (originalVideoRef.current) originalVideoRef.current.currentTime = time;

    // 同步所有节点的触发状态：目标时间之前的节点标记为已触发，之后的重置为未触发
    sortedNodes.forEach((n) => {
      if (n.interactionTime < time - 0.1) {
        triggeredNodeIds.current.add(n.id);
      } else {
        triggeredNodeIds.current.delete(n.id);
      }
    });

    // 如果当前活跃节点不在目标时间窗口内，中止 overlay
    const curActiveId = activeNodeIdRef.current;
    if (curActiveId) {
      const activeN = sortedNodes.find((n) => n.id === curActiveId);
      if (activeN && Math.abs(activeN.interactionTime - time) > 0.5) {
        stopReverse();
        setOverlayMode(null);
        setActiveNodeId(null);
      }
    }
  };

  const formatTime = (t) => {
    if (!t || isNaN(t)) return '00:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // 清理倒放
  useEffect(() => {
    return () => stopReverse();
  }, [stopReverse]);

  // ═══════════════ 导出合成视频（仅支持第一个节点） ═══════════════
  const exportCompositeVideo = useCallback(async () => {
    if (!videoSrc || sortedNodes.length === 0) {
      alert('请先完成视频上传和节点配置');
      return;
    }
    const firstNode = sortedNodes[0];
    if (!firstNode?.videoNaturalSize || !firstNode?.cropArea) {
      alert('请先完成视频上传和裁剪配置');
      return;
    }

    setIsExporting(true);
    setExportProgress('准备中...');

    let audioCtx = null;
    const allVids = []; // 统一收集，方便最后清理

    try {
      const natSize = firstNode.videoNaturalSize;
      const canvas = document.createElement('canvas');
      canvas.width = natSize.width;
      canvas.height = natSize.height;
      const ctx = canvas.getContext('2d');

      const createVid = (src) => {
        const v = document.createElement('video');
        v.src = src;
        v.playsInline = true;
        v.preload = 'auto';
        v.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.appendChild(v);
        allVids.push(v);
        return v;
      };

      const loadVid = (v) => new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; v.load(); });

      // 原视频
      const origVid = createVid(videoSrc);

      // 为每个节点创建视频元素
      const nodeVids = sortedNodes.map((node) => {
        const guidVid = node.guidanceVideo ? createVid(node.guidanceVideo) : null;
        const fbVid = node.feedbackVideo ? createVid(node.feedbackVideo) : null;
        const waitSrc = node.waitingVideo
          ? (typeof node.waitingVideo === 'string' ? node.waitingVideo : (node.waitingVideo?.original ?? node.waitingVideo?.forward ?? null))
          : null;
        const waitVid = waitSrc ? createVid(waitSrc) : null;
        return { guidVid, fbVid, waitVid };
      });

      setExportProgress('加载视频资源...');
      await Promise.all(allVids.map(loadVid));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audioCtx = new (window.AudioContext || (/** @type {any} */(window)).webkitAudioContext)();
      const audioDest = audioCtx.createMediaStreamDestination();
      const connectAudio = (vid) => {
        if (!vid) return;
        try {
          const source = audioCtx.createMediaElementSource(vid);
          source.connect(audioDest);
        } catch (e) {
          console.warn('Audio connect failed:', e);
        }
      };
      allVids.forEach(connectAudio);

      const FPS = 30;
      const FRAME_MS = 1000 / FPS;
      const canvasStream = canvas.captureStream(FPS);
      const videoTrack = canvasStream.getVideoTracks()[0];
      const audioTrack = audioDest.stream.getAudioTracks()[0];
      const combinedStream = audioTrack ? new MediaStream([videoTrack, audioTrack]) : canvasStream;

      let mimeType = 'video/webm;codecs=vp9,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

      const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(100);

      // ── 绘制工具（cropArea 作为参数，不再写死在闭包里） ──
      const drawStatus = (text) => {
        if (!text) return;
        ctx.save();
        const scale = canvas.width / 1280;
        const fontSize = Math.max(14, 20 * scale);
        ctx.font = `500 ${fontSize}px sans-serif`;
        const paddingX = 16 * scale, paddingY = 8 * scale;
        const textWidth = ctx.measureText(text).width;
        const x = 24 * scale, y = 24 * scale;
        const rectW = textWidth + paddingX * 2, rectH = fontSize + paddingY * 2, r = rectH / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + rectW - r, y);
        ctx.arcTo(x + rectW, y, x + rectW, y + r, r);
        ctx.lineTo(x + rectW, y + rectH - r);
        ctx.arcTo(x + rectW, y + rectH, x + rectW - r, y + rectH, r);
        ctx.lineTo(x + r, y + rectH);
        ctx.arcTo(x, y + rectH, x, y + rectH - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1 * scale; ctx.stroke();
        ctx.fillStyle = 'white'; ctx.textBaseline = 'middle';
        ctx.fillText(text, x + paddingX, y + rectH / 2 + 1 * scale);
        ctx.restore();
      };

      const draw = (overlayVid, cropArea, statusText = '') => {
        ctx.drawImage(origVid, 0, 0, canvas.width, canvas.height);
        if (overlayVid && cropArea) {
          ctx.drawImage(overlayVid, cropArea.x, cropArea.y, cropArea.width, cropArea.height);
        }
        if (statusText) drawStatus(statusText);
      };

      const drawWithBitmap = (bitmap, cropArea, statusText = '') => {
        ctx.drawImage(origVid, 0, 0, canvas.width, canvas.height);
        if (bitmap && cropArea) {
          ctx.drawImage(bitmap, cropArea.x, cropArea.y, cropArea.width, cropArea.height);
        }
        if (statusText) drawStatus(statusText);
      };

      const playOrigForward = (startT, endT, statusText = '播放中...') => new Promise((resolve) => {
        origVid.currentTime = startT;
        origVid.play();
        const loop = () => {
          draw(null, null, statusText);
          if (origVid.currentTime >= endT - 0.03 || origVid.ended) {
            origVid.pause();
            resolve();
          } else {
            requestAnimationFrame(loop);
          }
        };
        requestAnimationFrame(loop);
      });

      const playOverlay = (vid, cropArea, statusText = '') => new Promise((resolve) => {
        vid.currentTime = 0;
        vid.play();
        const loop = () => {
          draw(vid, cropArea, statusText);
          if (vid.currentTime >= vid.duration - 0.03 || vid.ended) {
            vid.pause();
            resolve();
          } else {
            requestAnimationFrame(loop);
          }
        };
        requestAnimationFrame(loop);
      });

      const playWaitForwardCapture = (waitVid, cropArea, startT, endT, statusText = '') => new Promise((resolve) => {
        const frames = [];
        waitVid.currentTime = startT;

        const captureFrame = async () => {
          if (waitVid.currentTime >= endT - 0.03 || waitVid.ended) {
            waitVid.pause();
            resolve(frames);
            return;
          }
          draw(waitVid, cropArea, statusText);
          try {
            frames.push(await createImageBitmap(waitVid));
          } catch (e) { /* skip */ }

          if ('requestVideoFrameCallback' in waitVid) {
            waitVid.requestVideoFrameCallback(captureFrame);
          } else {
            // fallback
            setTimeout(() => requestAnimationFrame(captureFrame), 1000 / 30);
          }
        };

        waitVid.play().then(() => {
          if ('requestVideoFrameCallback' in waitVid) {
            waitVid.requestVideoFrameCallback(captureFrame);
          } else {
            requestAnimationFrame(captureFrame);
          }
        });
      });

      const playFrames = (frames, cropArea, reverse, statusText = '') => new Promise((resolve) => {
        if (!frames || frames.length === 0) { resolve(); return; }
        let idx = reverse ? frames.length - 1 : 0;
        const step = reverse ? -1 : 1;
        let lastTime = performance.now();
        const FRAME_MS = 1000 / 30; // 30 FPS target

        const loop = (now) => {
          const delta = now - lastTime;
          if (delta >= FRAME_MS) {
            drawWithBitmap(frames[idx], cropArea, statusText);
            idx += step;
            lastTime = now - (delta % FRAME_MS);
          }

          if (reverse ? idx < 0 : idx >= frames.length) {
            resolve();
          } else {
            requestAnimationFrame(loop);
          }
        };
        requestAnimationFrame(loop);
      });

      // ── 主导出序列：逐节点处理 ──
      const total = sortedNodes.length;
      let prevTime = 0;

      for (let ni = 0; ni < total; ni++) {
        const node = sortedNodes[ni];
        const { guidVid, fbVid, waitVid } = nodeVids[ni];
        const cropArea = node.cropArea;
        const tag = total > 1 ? ` [节点 ${ni + 1}/${total}]` : '';

        // 1. 原视频播放到本节点交互点
        setExportProgress(`原视频播放中...${tag}`);
        await playOrigForward(prevTime, node.interactionTime, '播放中...');
        origVid.currentTime = node.interactionTime;

        // 2. 引导语视频
        if (guidVid) {
          setExportProgress(`引导语视频...${tag}`);
          await playOverlay(guidVid, cropArea, '正在播放引导语');
        }

        // 3. 等待循环
        if (waitVid) {
          let wait1Frames = null, wait2Frames = null;
          try {
            setExportProgress(`等待进入动作 (截帧)...${tag}`);
            wait1Frames = await playWaitForwardCapture(waitVid, cropArea, 0, WAIT_SPLIT_TIME, `等待交互中...${tag}`);

            const waitEnd = waitVid.duration - 0.05;
            setExportProgress(`等待循环 1/${waitLoopCount} 正放 (截帧)...${tag}`);
            wait2Frames = await playWaitForwardCapture(waitVid, cropArea, WAIT_SPLIT_TIME, waitEnd, `等待交互中...${tag}`);

            setExportProgress(`等待循环 1/${waitLoopCount} 倒放...${tag}`);
            await playFrames(wait2Frames, cropArea, true, `等待交互中...${tag}`);

            for (let loop = 1; loop < waitLoopCount; loop++) {
              setExportProgress(`等待循环 ${loop + 1}/${waitLoopCount} 正放...${tag}`);
              await playFrames(wait2Frames, cropArea, false, `等待交互中...${tag}`);
              setExportProgress(`等待循环 ${loop + 1}/${waitLoopCount} 倒放...${tag}`);
              await playFrames(wait2Frames, cropArea, true, `等待交互中...${tag}`);
            }

            if (wait1Frames && wait1Frames.length > 0) {
              setExportProgress(`等待退出动作 倒放...${tag}`);
              await playFrames(wait1Frames, cropArea, true, `等待交互中...${tag}`);
            }
          } finally {
            wait1Frames?.forEach(b => b.close());
            wait2Frames?.forEach(b => b.close());
          }
        }

        // 4. 反馈语视频
        if (fbVid) {
          setExportProgress(`反馈语视频...${tag}`);
          await playOverlay(fbVid, cropArea, '正在播放反馈语');
        }

        prevTime = node.interactionTime;
      }

      // 5. 最后一段原视频（最后节点 → 结束）
      setExportProgress('原视频收尾...');
      await playOrigForward(prevTime, origVid.duration, '播放中...');

      // 6. 停止录制并下载
      setExportProgress('生成文件中...');
      recorder.stop();
      await new Promise((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `composite_${Date.now()}.webm`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          resolve();
        };
      });

    } catch (err) {
      console.error('Export failed:', err);
      alert('导出失败: ' + err.message);
    } finally {
      allVids.forEach(v => { v.pause(); v.remove(); });
      if (audioCtx) audioCtx.close().catch(() => { });
      setIsExporting(false);
      setExportProgress('');
    }
  }, [videoSrc, sortedNodes]);

  // ═══════════════ FFmpeg WASM 快速导出 ═══════════════
  const exportCompositeVideoFFmpeg = useCallback(async () => {
    if (!videoSrc || sortedNodes.length === 0) {
      alert('请先完成视频上传和节点配置');
      return;
    }
    const firstNode = sortedNodes[0];
    if (!firstNode?.videoNaturalSize || !firstNode?.cropArea) {
      alert('请先完成视频上传和裁剪配置');
      return;
    }

    setIsExporting(true);
    setExportProgress('准备中...');

    try {
      const blob = await exportCompositeFFmpeg({
        videoSrc,
        sortedNodes,
        waitLoopCount,
        onProgress: (text) => setExportProgress(text),
        onLog: (msg) => console.log('[FFmpeg Export]', msg),
      });

      // 下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `composite_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('FFmpeg export failed:', err);
      alert('FFmpeg 导出失败: ' + err.message);
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  }, [videoSrc, sortedNodes, waitLoopCount]);

  const handleExport = useCallback(() => {
    if (exportMode === 'ffmpeg') {
      exportCompositeVideoFFmpeg();
    } else {
      exportCompositeVideo();
    }
  }, [exportMode, exportCompositeVideoFFmpeg, exportCompositeVideo]);

  // ═══════════════ 分段高光批量导出（后端方案） ═══════════════
  const exportSingleNodeHighlight = useCallback(async (node, ni, totalNodes) => {
    const clipLabel = node.label || `交互节点${ni + 1}`;
    setExportProgress(`切片中 [${ni + 1}/${totalNodes}]: ${clipLabel}`);

    // 1. 获取 20s 原视频片段 Blob
    const startTime = Math.max(0, node.interactionTime - 10);
    const relativeTime = node.interactionTime - startTime;
    const sliceBlob = await cutVideoSegment({
      videoSrc,
      startTime,
      duration: 20,
      onLog: (msg) => console.log(`[FFmpeg Slice ${ni}]`, msg)
    });

    // 2. 将辅助视频转换为 Blob
    const fetchBlob = async (url) => url ? (await fetch(url)).blob() : null;

    const gBlob = await fetchBlob(node.guidanceVideo);
    const fBlob = await fetchBlob(node.feedbackVideo);
    const waitSrc = node.waitingVideo ? (typeof node.waitingVideo === 'string' ? node.waitingVideo : (node.waitingVideo.original || node.waitingVideo.forward)) : null;
    const wBlob = await fetchBlob(waitSrc);

    const formData = new FormData();
    formData.append('original_clip', sliceBlob, 'original.mp4');
    if (gBlob) formData.append('guidance_clip', gBlob, 'guidance.mp4');
    if (fBlob) formData.append('feedback_clip', fBlob, 'feedback.mp4');
    if (wBlob) formData.append('waiting_clip', wBlob, 'waiting.mp4');

    const params = {
      relativeInteractionTime: relativeTime,
      waitLoopCount: waitLoopCount,
      cropArea: node.cropArea,
      videoNaturalSize: node.videoNaturalSize
    };
    formData.append('params', JSON.stringify(params));

    // 3. POST 给后端
    setExportProgress(`后端合成中 [${ni + 1}/${totalNodes}]: ${clipLabel}...`);
    const res = await fetch(getExportNodeClipUrl(), {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`后端合成失败: ${await res.text()}`);
    }

    // 4. 下载
    setExportProgress(`保存导出 [${ni + 1}/${totalNodes}]`);
    const resultBlob = await res.blob();
    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `高光切片-${clipLabel}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [videoSrc, waitLoopCount, setExportProgress]);

  const batchExportHighlights = useCallback(async () => {
    if (!videoSrc || sortedNodes.length === 0) {
      alert('请先完成视频上传和节点配置');
      return;
    }
    const firstNode = sortedNodes[0];
    if (!firstNode?.videoNaturalSize || !firstNode?.cropArea) {
      alert('请先完成视频上传和裁剪配置');
      return;
    }

    setIsExporting(true);

    try {
      for (let ni = 0; ni < sortedNodes.length; ni++) {
        const node = sortedNodes[ni];
        await exportSingleNodeHighlight(node, ni, sortedNodes.length);
      }
    } catch (err) {
      console.error('Batch export failed:', err);
      alert('批量导出失败: ' + err.message);
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  }, [videoSrc, sortedNodes, exportSingleNodeHighlight]);

  const exportCurrentNodeHighlight = useCallback(async () => {
    const state = useStore.getState();
    const globalActiveNodeId = state.activeNodeId;
    const globalActiveNode = state.nodes.find(n => n.id === globalActiveNodeId);
    
    if (!videoSrc || !globalActiveNode) {
      alert('请先完成视频上传并在左侧控制面板选择一个节点');
      return;
    }
    if (!globalActiveNode.videoNaturalSize || !globalActiveNode.cropArea) {
      alert('请先完成当前节点的裁剪配置');
      return;
    }

    setIsExporting(true);
    
    try {
      const nodeIndex = sortedNodes.findIndex(n => n.id === globalActiveNode.id);
      await exportSingleNodeHighlight(globalActiveNode, nodeIndex >= 0 ? nodeIndex : 0, 1);
    } catch (err) {
      console.error('Single export failed:', err);
      alert('当前节点导出失败: ' + err.message);
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  }, [videoSrc, sortedNodes, exportSingleNodeHighlight]);


  // 时间轴计算
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 等待视频可见性
  const waitingVisible = overlayMode === 'waiting';

  // ═══════════════ 渲染 ═══════════════
  return (
    <div className="flex flex-col h-full w-full bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      {/* 视频区域 */}
      <div
        ref={containerRef}
        className="flex-1 bg-black relative flex items-center justify-center overflow-hidden"
      >
        {videoSrc ? (
          <>
            {/* 拖拽内容区 */}
            <div
              className="absolute top-1/2 left-1/2"
              style={{
                transformOrigin: 'center center',
                transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) scale(${innerScale})`,
                width: naturalSize?.width ? `${naturalSize.width}px` : '100%',
                height: naturalSize?.height ? `${naturalSize.height}px` : '100%',
              }}
            >
              {/* 原始视频（底层） */}
              <video
                ref={originalVideoRef}
                src={videoSrc}
                className="absolute inset-0 w-full h-full object-fill z-10 pointer-events-none"
                style={{ willChange: 'transform' }}
                playsInline
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleOriginalEnded}
                onPlay={handleVideoPlay}
                onPause={handleVideoPause}
              />

              {/* 等待视频 */}
              {waitingVideo && (
                <video
                  ref={waitingVideoRef}
                  src={typeof waitingVideo === 'string' ? waitingVideo : (waitingVideo?.original || waitingVideo?.forward || waitingVideo)}
                  style={{
                    ...overlayStyle,
                    opacity: waitingVisible ? 1 : 0,
                    visibility: waitingVisible ? 'visible' : 'hidden',
                    zIndex: waitingVisible ? 20 : -1,
                  }}
                  className="absolute object-fill pointer-events-none"
                  playsInline
                  preload="auto"
                  onTimeUpdate={handleWaitingTimeUpdate}
                />
              )}

              {/* 引导语视频 */}
              {currentGuidanceUrl && (
                <video
                  ref={guidanceVideoRef}
                  src={currentGuidanceUrl}
                  style={{
                    ...overlayStyle,
                    opacity: overlayMode === 'guidance' ? 1 : 0,
                    visibility: overlayMode === 'guidance' ? 'visible' : 'hidden',
                    zIndex: overlayMode === 'guidance' ? 20 : -1,
                  }}
                  className="absolute object-fill pointer-events-none"
                  playsInline
                  preload="auto"
                  onEnded={handleOverlayEnded}
                />
              )}

              {/* 反馈语视频 */}
              {currentFeedbackUrl && (
                <video
                  ref={feedbackVideoRef}
                  src={currentFeedbackUrl}
                  style={{
                    ...overlayStyle,
                    opacity: overlayMode === 'feedback' ? 1 : 0,
                    visibility: overlayMode === 'feedback' ? 'visible' : 'hidden',
                    zIndex: overlayMode === 'feedback' ? 20 : -1,
                  }}
                  className="absolute object-fill pointer-events-none"
                  playsInline
                  preload="auto"
                  onEnded={handleOverlayEnded}
                />
              )}

              {/* 状态指示 */}
              <div className="absolute top-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-sm rounded-full text-white text-xs font-medium border border-white/10 z-50 pointer-events-none whitespace-nowrap">
                {isExporting && `视频导出中: ${exportProgress}`}
                {!isExporting && (
                  <>
                    {overlayMode === 'waiting' && `等待交互中... [${waitingPhase}]`}
                    {overlayMode === 'guidance' && '正在播放引导语'}
                    {overlayMode === 'feedback' && '正在播放反馈语'}
                    {!overlayMode && isPlaying && '播放中...'}
                    {!overlayMode && !isPlaying && '已暂停'}
                  </>
                )}
              </div>

              {/* 当前节点指示 */}
              {sortedNodes.length > 1 && activeNodeId && (
                <div className="absolute top-4 right-4 px-2 py-1 bg-black/60 backdrop-blur-sm rounded-full text-white text-xs font-medium border border-white/10 z-50 pointer-events-none">
                  节点 {sortedNodes.findIndex((n) => n.id === activeNodeId) + 1}/{sortedNodes.length}
                </div>
              )}
            </div>

            {/* 顶层透明的拖拽和点击层 */}
            <div
              className="absolute inset-0 z-30 cursor-grab active:cursor-grabbing group/play"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            >
              <div className="w-full h-full flex items-center justify-center bg-transparent transition-colors group-hover/play:bg-black/10">
                <div className={`p-3 rounded-full bg-black/40 backdrop-blur-sm border border-white/20 transition-all duration-150 group-hover/play:scale-110 group-hover/play:opacity-100 ${isPlaying || overlayMode ? 'opacity-0' : 'opacity-100'}`}>
                  <Play className="w-8 h-8 text-white ml-0.5" />
                </div>
              </div>
            </div>

            {/* 底部时间轴 */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent pt-8 pb-3 px-4 z-40 transition-opacity">
              <div className="relative w-full group/slider flex items-center">
                {/* 所有节点的标记 */}
                {sortedNodes.map((node, i) => (
                  <div
                    key={node.id}
                    className="absolute top-1/2 -translate-y-1/2 z-10 translate-x-[-50%] group/node"
                    style={{ left: `${duration > 0 ? (node.interactionTime / duration) * 100 : 0}%` }}
                  >
                    <div
                      className={`w-3 h-3 rounded-full shadow-[0_0_8px_rgba(251,191,36,0.8)] border-2 border-white ${
                        node.id === activeNodeId ? 'bg-amber-400' :
                        triggeredNodeIds.current.has(node.id) ? 'bg-slate-400' : 'bg-amber-200'
                      }`}
                      title={`交互节点 #${i + 1}: ${node.interactionTime.toFixed(2)}s`}
                    />
                    {/* label */}
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-amber-400 text-black text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap opacity-0 group-hover/slider:opacity-100 transition-opacity pointer-events-none">
                      #{i + 1}
                    </div>
                    {/* 删除按钮 */}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNode(node.id); }}
                      className="absolute -top-7 left-1/2 -translate-x-1/2 p-0.5 bg-red-500 hover:bg-red-600 rounded-full opacity-0 group-hover/node:opacity-100 transition-opacity"
                      title="删除此节点"
                    >
                      <X className="w-2.5 h-2.5 text-white" />
                    </button>
                  </div>
                ))}

                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.01}
                  value={currentTime}
                  onChange={handleTimelineChange}
                  className="video-timeline-slider w-full"
                  style={{ '--progress': `${progressPercent}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-1.5 text-[11px] text-white/80 font-mono">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center text-slate-500">
            <p>暂无视频</p>
            <p className="text-xs mt-2">请先上传视频并选取交互点</p>
          </div>
        )}
      </div>

      {/* ── 导出工具栏 ── */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-slate-100 bg-white">
        {/* 左：循环次数 + 模式切换 */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 select-none">
            <span>等待循环</span>
            <input
              type="number"
              min={1}
              max={20}
              value={waitLoopCount}
              onChange={(e) => setWaitLoopCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 3)))}
              disabled={isExporting}
              className="w-10 px-1.5 py-0.5 text-center text-xs border border-slate-200 rounded-md bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:opacity-50"
            />
            <span>次</span>
          </label>
          <div className="flex rounded-md border border-slate-200 overflow-hidden text-xs">
            <button
              onClick={() => setExportMode('ffmpeg')}
              disabled={isExporting}
              className={`px-2.5 py-1 transition-colors ${exportMode === 'ffmpeg' ? 'bg-slate-800 text-white font-medium' : 'bg-white text-slate-500 hover:bg-slate-50'} disabled:opacity-50`}
              title="FFmpeg 模式：速度快，合并全程"
            >全程</button>
            <button
              onClick={() => setExportMode('recorder')}
              disabled={isExporting}
              className={`px-2.5 py-1 border-l border-slate-200 transition-colors ${exportMode === 'recorder' ? 'bg-slate-800 text-white font-medium' : 'bg-white text-slate-500 hover:bg-slate-50'} disabled:opacity-50`}
              title="录制模式：兼容性好"
            >录制</button>
          </div>
        </div>

        {/* 右：导出按钮 */}
        <div className="flex items-center gap-2">
          <button
            onClick={exportCurrentNodeHighlight}
            disabled={isExporting || !videoSrc || !globalActiveNodeId}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              isExporting ? 'bg-amber-50 text-amber-600 border-amber-200 pointer-events-none'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-amber-50 hover:text-amber-600 hover:border-amber-300'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title="导出当前选中的交互节点的高光片段"
          >
            {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
            导出当前
          </button>
          <button
            onClick={batchExportHighlights}
            disabled={isExporting || !videoSrc || sortedNodes.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              isExporting ? 'bg-blue-50 text-blue-600 border-blue-200 pointer-events-none'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title="批量导出所有交互节点的高光片段"
          >
            {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
            批量高光
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !videoSrc || sortedNodes.length === 0}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
              isExporting ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300 pointer-events-none'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{isExporting ? exportProgress : '导出'}</span>
          </button>
        </div>
      </div>

      {/* ── 播放控制栏 ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50">

        {/* 播放/暂停 */}
        <button
          onClick={togglePlay}
          disabled={!videoSrc}
          title={isPlaying || overlayMode ? '暂停 (空格)' : '播放 (空格)'}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-200 disabled:cursor-not-allowed text-white transition-colors flex-shrink-0"
        >
          {isPlaying || overlayMode
            ? <Pause className="w-3.5 h-3.5" />
            : <Play className="w-3.5 h-3.5 ml-0.5" />}
        </button>

        <div className="w-px h-5 bg-slate-200 mx-1 flex-shrink-0" />

        {/* 添加节点 */}
        <button
          onClick={handleAddNode}
          disabled={!videoSrc || !globalCropArea}
          title={!globalCropArea ? '请先在左侧设置裁剪区域' : '在当前时间点添加交互节点'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          添加节点
        </button>

        <div className="w-px h-5 bg-slate-200 mx-1 flex-shrink-0" />

        {/* 引导语 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <MessageCircle className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
          <span className="text-xs text-slate-500 font-medium">提问</span>
          {guidanceList.filter(g => g.videoUrl).length > 0
            ? guidanceList.filter(g => g.videoUrl).map((item, idx) => (
              <button
                key={item.id}
                onClick={() => triggerInteraction('guidance', item.videoUrl)}
                disabled={overlayMode === 'guidance' || isExporting}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  overlayMode === 'guidance' && currentGuidanceUrl === item.videoUrl
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >引导 {idx + 1}</button>
            ))
            : <button
                onClick={() => triggerInteraction('guidance')}
                disabled={!guidanceVideo || overlayMode === 'guidance' || isExporting}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  overlayMode === 'guidance'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >引导语</button>
          }
        </div>

        <div className="w-px h-5 bg-slate-200 mx-1 flex-shrink-0" />

        {/* 反馈语 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
          <span className="text-xs text-slate-500 font-medium">交互</span>
          {feedbackList.filter(f => f.videoUrl).length > 0
            ? feedbackList.filter(f => f.videoUrl).map((item, idx) => (
              <button
                key={item.id}
                onClick={() => triggerInteraction('feedback', item.videoUrl)}
                disabled={overlayMode === 'feedback' || isExporting}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  overlayMode === 'feedback' && currentFeedbackUrl === item.videoUrl
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-600'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >反馈 {idx + 1}</button>
            ))
            : <button
                onClick={() => triggerInteraction('feedback')}
                disabled={!feedbackVideo || overlayMode === 'feedback' || isExporting}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-all ${
                  overlayMode === 'feedback'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-600'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >反馈语</button>
          }
        </div>

      </div>
    </div>
  );
};

export default VideoPlayer;
