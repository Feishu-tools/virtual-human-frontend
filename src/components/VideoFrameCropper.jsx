import { useState, useRef, useCallback, useEffect } from 'react';
import Cropper from 'react-cropper';
import 'cropperjs/dist/cropper.css';
import useStore from '../store/useStore';
import {
  Upload,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Play,
  Pause,
  Check,
  CheckCircle2,
  Info,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

/**
 * 两阶段组件：
 * 1. upload - 上传视频
 * 2. crop   - 直接显示 Cropper + 时间轴（拖动时间轴自动更新帧，保留选框位置）
 */
const VideoFrameCropper = () => {
  const nodes             = useStore((s) => s.nodes);
  const storeVideoSrc     = useStore((s) => s.videoSrc);
  const setVideoSrc       = useStore((s) => s.setVideoSrc);
  const globalCropArea    = useStore((s) => s.globalCropArea);
  const setGlobalCropArea = useStore((s) => s.setGlobalCropArea);
  const setWorkspaceMode  = useStore((s) => s.setWorkspaceMode);

  const [stage, setStage] = useState('upload'); // 'upload' | 'crop'

  // ── 视频 ──
  const [videoSrc, setLocalVideoSrc] = useState(null);
  const [isPlaying, setIsPlaying]    = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]      = useState(0);
  const videoRef = useRef(null);
  const initialFrameCaptured = useRef(false);

  // ── Cropper ──
  const [frameImage, setFrameImage]             = useState(null);
  const [videoNaturalSize, setVideoNaturalSize] = useState({ width: 0, height: 0 });
  const cropperRef   = useRef(null);
  const savedCropData = useRef(null); // 切帧时保存选框，ready 回调后恢复

  // ── 裁剪状态 ──
  const [cropPreviewData, setCropPreviewData] = useState(null);
  const [cropConfirmed, setCropConfirmed]     = useState(false);
  const [cropPreviewBlob, setCropPreviewBlob] = useState(null);
  const [aspectRatio, setAspectRatio]         = useState(0); // 0 = 自由
  const autoHideTimer = useRef(null);

  const fileInputRef = useRef(null);

  // 确认裁剪后 1.5s 自动关闭预览 overlay
  useEffect(() => {
    if (cropConfirmed) {
      autoHideTimer.current = setTimeout(() => setCropConfirmed(false), 1500);
    }
    return () => clearTimeout(autoHideTimer.current);
  }, [cropConfirmed]);

  // demo 加载时同步 videoSrc
  useEffect(() => {
    if (storeVideoSrc && storeVideoSrc !== videoSrc) {
      setLocalVideoSrc(storeVideoSrc);
      initialFrameCaptured.current = false;
      setStage('crop');
    }
  }, [storeVideoSrc]);

  // ── 帧捕获 ──
  const captureCurrentFrame = useCallback((preserveBox = false) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    if (preserveBox && cropperRef.current?.cropper) {
      savedCropData.current = cropperRef.current.cropper.getData() ?? null;
    }

    const { videoWidth, videoHeight } = video;
    setVideoNaturalSize({ width: videoWidth, height: videoHeight });

    const canvas = document.createElement('canvas');
    canvas.width  = videoWidth;
    canvas.height = videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    setCropConfirmed(false);
    setCropPreviewBlob(null);
    
    // 使用 jpeg 格式大幅提升编码速度，避免 PNG 导致主线程卡顿
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    if (preserveBox && cropperRef.current?.cropper) {
      // 若 Cropper 已经挂载，则直接调用底层 replace(url, hasSameSize=true) 
      // 这样不会销毁 Cropper 实例，画面不会闪黑
      cropperRef.current.cropper.replace(dataUrl, true);
    } else {
      setFrameImage(dataUrl);
    }
  }, []);

  // ── 视频事件 ──
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (video) setDuration(video.duration);
  };

  // loadeddata: 自动跳到第 1s 作为参考帧（短视频则直接捕获当前帧）
  const handleLoadedData = useCallback(() => {
    if (initialFrameCaptured.current) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.duration > 1) {
      video.currentTime = 1;   // 触发 handleSeeked 完成首次捕获
      setCurrentTime(1);
    } else {
      initialFrameCaptured.current = true;
      captureCurrentFrame(false);
    }
  }, [captureCurrentFrame]);

  // seeked: 首次 seek（跳到 1s）或用户拖动时间轴后更新帧
  const handleSeeked = useCallback(() => {
    const preserve = initialFrameCaptured.current; // 首次 false，后续 true（保留选框）
    if (!initialFrameCaptured.current) initialFrameCaptured.current = true;
    captureCurrentFrame(preserve);
  }, [captureCurrentFrame]);

  const handleTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };

  const handleVideoEnded = () => setIsPlaying(false);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); } else { videoRef.current.play(); }
    setIsPlaying(!isPlaying);
  };

  const handleSliderChange = (e) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); }
      videoRef.current.currentTime = time; // triggers handleSeeked
    }
  };

  // ── 帧步进控制 ──
  const stepFrame = useCallback((forward = true) => {
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); }
    // 假设 30FPS，一帧约 0.0333 秒
    const stepTime = 1 / 30;
    const newTime = Math.max(0, Math.min(videoRef.current.currentTime + (forward ? stepTime : -stepTime), duration));
    setCurrentTime(newTime);
    videoRef.current.currentTime = newTime;
  }, [isPlaying, duration]);

  const stepIntervalRef = useRef(null);

  const startStepping = useCallback((forward) => {
    stepFrame(forward); // 先走一帧
    stepIntervalRef.current = setInterval(() => {
      stepFrame(forward);
    }, 50); // 每50ms快进/快退一次
  }, [stepFrame]);

  const stopStepping = useCallback(() => {
    if (stepIntervalRef.current) {
      clearInterval(stepIntervalRef.current);
      stepIntervalRef.current = null;
    }
  }, []);

  // ── 上传 ──
  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    const url = URL.createObjectURL(file);
    setLocalVideoSrc(url);
    setVideoSrc(url);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setFrameImage(null);
    setCropPreviewData(null);
    setCropConfirmed(false);
    setCropPreviewBlob(null);
    initialFrameCaptured.current = false;
    setStage('crop');
  };

  // ── Cropper 就绪时恢复选框 ──
  const handleCropperReady = useCallback(() => {
    if (savedCropData.current) {
      try { cropperRef.current?.cropper?.setData(savedCropData.current); } catch (_) {}
      savedCropData.current = null;
    }
  }, []);

  // ── 裁剪变化 ──
  const onCropChange = useCallback(() => {
    // 使用 requestAnimationFrame 减少高频触发时的计算负担
    requestAnimationFrame(() => {
      const cropper = cropperRef.current?.cropper;
      if (!cropper || typeof cropper.getData !== 'function') return;
      const raw = cropper.getData();
      if (!raw || raw.width === 0 || raw.height === 0) return;
      const natW = videoNaturalSize.width  || raw.width;
      const natH = videoNaturalSize.height || raw.height;
      const x = Math.max(0, Math.round(raw.x));
      const y = Math.max(0, Math.round(raw.y));
      const w = Math.min(Math.round(raw.width),  natW - x);
      const h = Math.min(Math.round(raw.height), natH - y);
      setCropPreviewData({ x, y, width: w, height: h });
      setCropConfirmed(false);
    });
  }, [videoNaturalSize]);

  // ── 确认裁剪 ──
  const confirmCrop = useCallback(() => {
    const cropper = cropperRef.current?.cropper;
    if (!cropper || typeof cropper.getCroppedCanvas !== 'function') return;
    const raw = cropper.getData();
    if (!raw || raw.width === 0 || raw.height === 0) { alert('请先框选裁剪区域！'); return; }
    const natW = videoNaturalSize.width  || raw.width;
    const natH = videoNaturalSize.height || raw.height;
    const x = Math.max(0, Math.round(raw.x));
    const y = Math.max(0, Math.round(raw.y));
    const w = Math.min(Math.round(raw.width),  natW - x);
    const h = Math.min(Math.round(raw.height), natH - y);
    try {
      const canvas = cropper.getCroppedCanvas(
        aspectRatio === 384 / 256 ? { width: 384, height: 256 }
          : aspectRatio === 256 / 384 ? { width: 256, height: 384 } : undefined
      );
      if (!canvas) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        setGlobalCropArea({ x, y, width: w, height: h }, { width: natW, height: natH }, blob, currentTime);
        setCropPreviewBlob(blob);
        setCropConfirmed(true);
        setTimeout(() => setWorkspaceMode('preview'), 1500);
      });
    } catch (err) {
      console.error('VideoFrameCropper: confirmCrop error', err);
    }
  }, [setGlobalCropArea, setWorkspaceMode, videoNaturalSize, aspectRatio]);

  const handleZoomPin = useCallback(() => {
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    const d = cropper.getData();
    setTimeout(() => cropper.setData(d), 0);
  }, []);

  const handleZoomIn  = () => cropperRef.current?.cropper?.zoom(0.1);
  const handleZoomOut = () => cropperRef.current?.cropper?.zoom(-0.1);
  const handleRotate  = () => cropperRef.current?.cropper?.rotate(90);

  const handleAspectRatioChange = (e) => {
    const r = Number(e.target.value);
    setAspectRatio(r);
    const cropper = cropperRef.current?.cropper;
    if (cropper) cropper.setAspectRatio(r === 0 ? NaN : r);
  };

  const resetAll = () => {
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    setLocalVideoSrc(null);
    setVideoSrc(null);
    setFrameImage(null);
    setStage('upload');
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setCropPreviewData(null);
    setCropConfirmed(false);
    setCropPreviewBlob(null);
    initialFrameCaptured.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const formatTime = (t) => {
    if (!t || isNaN(t)) return '00:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const sortedNodes = [...nodes].sort((a, b) => a.interactionTime - b.interactionTime);

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 rounded-xl overflow-hidden shadow-sm border border-slate-200">

      {/* ═══════════════ 上传阶段 ═══════════════ */}
      {stage === 'upload' && (
        <div className="flex flex-col h-full p-4 gap-3">
          <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer relative group">
            <input
              ref={fileInputRef}
              type="file"
              onChange={onFileChange}
              accept="video/*"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="bg-blue-100 p-4 rounded-full mb-4 group-hover:bg-blue-200 transition-colors">
              <Upload className="w-8 h-8 text-blue-600" />
            </div>
            <p className="text-lg font-medium text-slate-700">点击或拖拽上传视频</p>
            <p className="text-sm text-slate-500 mt-2">支持 MP4, WebM 等格式</p>
          </div>

          {/* 全局裁剪区域状态 */}
          <div className={`px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2 ${
            globalCropArea
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              : 'bg-amber-50 border border-amber-200 text-amber-700'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${globalCropArea ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            {globalCropArea
              ? `裁剪区域已设置 · ${globalCropArea.width} × ${globalCropArea.height} px`
              : '裁剪区域未设置 · 请上传视频后框选设定'}
          </div>
        </div>
      )}

      {/* ═══════════════ 裁剪阶段 ═══════════════ */}
      {stage === 'crop' && (
        <div className="flex flex-col h-full">
          {/* 隐藏视频：仅用于帧捕获和时间轴拖动 */}
          <video
            ref={videoRef}
            src={videoSrc}
            className="hidden"
            onLoadedMetadata={handleLoadedMetadata}
            onLoadedData={handleLoadedData}
            onSeeked={handleSeeked}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleVideoEnded}
            playsInline
          />

          {/* Cropper 主区域 */}
          <div className="relative flex-1 bg-slate-900 m-4 mb-0 rounded-t-lg overflow-hidden flex flex-col items-center justify-center">
            {frameImage ? (
              <>
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-black/60 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 pointer-events-none border border-white/10 shadow-lg">
                  <Info className="w-3.5 h-3.5 text-amber-400" />
                  当前画面将被截取为<span className="text-amber-400">参考帧</span>，用于等待态的生成，需要选取老师正常的图片
                </div>
                <Cropper
                  ref={cropperRef}
                  src={frameImage}
                  style={{ height: '100%', width: '100%' }}
                  aspectRatio={aspectRatio === 0 ? NaN : aspectRatio}
                  guides={false}
                  viewMode={1}
                  dragMode="crop"
                  cropBoxMovable
                  cropBoxResizable
                  background={false}
                  responsive
                  autoCropArea={0.5}
                  modal
                  highlight={false}
                  center={false}
                  checkOrientation={false}
                  restore={false}
                  crop={onCropChange}
                  zoom={handleZoomPin}
                  ready={handleCropperReady}
                  className="cropper-container-custom"
                />

                {/* 成功 overlay */}
                {cropConfirmed && cropPreviewBlob && (
                  <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center z-10 animate-in fade-in duration-300">
                    <div
                      className="rounded-xl overflow-hidden border-4 border-emerald-500 shadow-2xl bg-slate-800"
                      style={{ maxWidth: '80%', maxHeight: '70%' }}
                    >
                      <img
                        src={URL.createObjectURL(cropPreviewBlob)}
                        alt="Crop Preview"
                        className="w-full h-full object-contain"
                        onLoad={(e) => URL.revokeObjectURL(e.target.src)}
                      />
                    </div>
                    <div className="mt-4 flex flex-col items-center gap-2">
                      <div className="flex items-center gap-2 text-emerald-400 font-bold text-lg">
                        <CheckCircle2 className="w-6 h-6" />
                        全局裁剪区域已设置
                      </div>
                      <div className="bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-full text-sm text-emerald-300 font-mono font-medium">
                        {cropPreviewData?.width} × {cropPreviewData?.height} px
                      </div>
                      <p className="text-slate-400 text-sm mt-1">
                        请前往右侧播放器在目标时间点添加节点
                      </p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-slate-500 text-sm">正在加载视频帧...</div>
            )}
          </div>

          {/* 时间轴 */}
          <div className="mx-4 bg-slate-800 rounded-b-lg px-4 py-2">
            <div className="relative w-full">
              {sortedNodes.map((node) => (
                <div
                  key={node.id}
                  className="absolute top-1/2 w-2 h-2 bg-amber-400 rounded-full border border-white z-10 pointer-events-none"
                  style={{
                    left: `${duration > 0 ? (node.interactionTime / duration) * 100 : 0}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              ))}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.01}
                value={currentTime}
                onChange={handleSliderChange}
                className="video-timeline-slider w-full"
                style={{ '--progress': `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400 font-mono">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* 工具栏 */}
          <div className="px-4 py-3 bg-white border-t border-slate-100 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <button onClick={togglePlay} className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-600" title={isPlaying ? '暂停' : '播放'}>
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <div className="h-5 w-px bg-slate-200 mx-1" />
              <button 
                onMouseDown={() => startStepping(false)}
                onMouseUp={stopStepping}
                onMouseLeave={stopStepping}
                onTouchStart={() => startStepping(false)}
                onTouchEnd={stopStepping}
                className="p-1 hover:bg-slate-100 rounded-full transition-colors text-slate-600" 
                title="上一帧 (按住连退)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button 
                onMouseDown={() => startStepping(true)}
                onMouseUp={stopStepping}
                onMouseLeave={stopStepping}
                onTouchStart={() => startStepping(true)}
                onTouchEnd={stopStepping}
                className="p-1 hover:bg-slate-100 rounded-full transition-colors text-slate-600" 
                title="下一帧 (按住连进)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="h-5 w-px bg-slate-200 mx-1" />
              <button onClick={handleZoomOut} className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-600" title="缩小"><ZoomOut className="w-4 h-4" /></button>
              <button onClick={handleZoomIn}  className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-600" title="放大"><ZoomIn  className="w-4 h-4" /></button>
              <button onClick={handleRotate}  className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-600" title="旋转"><RotateCw className="w-4 h-4" /></button>
              <div className="h-5 w-px bg-slate-200 mx-1" />
              <select
                value={aspectRatio}
                onChange={handleAspectRatioChange}
                className="text-xs border border-slate-300 rounded-md px-1.5 py-1 bg-white text-slate-700 outline-none"
              >
                <option value={0}>自由</option>
                <option value={1}>1:1</option>
                <option value={384 / 256}>384:256</option>
                <option value={256 / 384}>256:384</option>
              </select>
            </div>

            <div className="flex-1 flex items-center justify-center">
              {cropPreviewData ? (
                <span className="text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-200 rounded px-2 py-1">
                  {cropPreviewData.width} × {cropPreviewData.height} px · ({cropPreviewData.x}, {cropPreviewData.y})
                </span>
              ) : (
                <span className="text-[10px] text-slate-400">拖动裁剪框以选取区域</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={confirmCrop}
                disabled={!cropPreviewData}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  cropConfirmed
                    ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                } disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed`}
                title="确认裁剪并设为全局裁剪区域"
              >
                <Check className="w-4 h-4" />
                {cropConfirmed ? '已确认' : '确认裁剪'}
              </button>
              <button
                onClick={resetAll}
                className="text-xs text-red-500 hover:text-red-700 px-2.5 py-1.5 hover:bg-red-50 rounded-md transition-colors"
              >
                重新上传
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoFrameCropper;
