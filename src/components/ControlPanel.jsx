import React, { useState, useRef } from 'react';
import { Play, Loader2, Send, MessageSquare, Video, Upload, Music, X, Trash2, ChevronDown, Download } from 'lucide-react';
import JSZip from 'jszip';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import useStore from '../store/useStore';
import { exportProjectToZip, importProjectFromZip } from '../utils/projectZip';
import { cutVideoSegment, extractVideoFrame, cutBoomerangVideoSegment, cutBackwardBoomerangVideoSegment, splitWaitingVideo } from '../utils/ffmpegExport';
import {
  getGenerateVideoUrl,
  getTtsCloneUrl,
  getSyncVideoUrl,
  getMergeGenUrl,
  getLipSyncUrl,
  getExportCompositeUrl,
  getReferenceFrameGenUrl,
  getWaitingGenUrl
} from '../config/api';

const DEFAULT_WAITING_PROMPT = '一位气质温和的成年人坐在电脑摄像头前，过渡到正视镜头。不进行任何姿态调整或纠正，不从当前姿态过渡到其他姿态。人物处于冻结的低动态待机状态，身体整体几乎完全静止，仅允许极微弱、随机、非节奏性的微动，这些微动不体现呼吸节奏，不形成周期性起伏。仅允许偶发自然眨眼和极轻微、无方向性的头部稳定微漂移。所有动作必须连续、平滑、低幅、无明显起止点、无节奏峰值，适合正放与倒放无缝循环。禁止任何具有方向性或语义性的动作，包括说话、张口、发音口型、点头、摇头、转头、身体前倾或后仰、姿态调整、表情推进。双唇始终自然闭合，全程无发音口型，无 lip sync。镜头固定，眼平视角，镜头完全锁定，无任何移动或变化，人物与镜头距离始终一致，构图保持完全不变。画面完全静音，无人声，无环境音，无音乐。禁止突然动作，禁止节奏变化，禁止呼吸被强化，禁止姿态修正，禁止前探或后坐，禁止画面漂移，禁止视角延伸，禁止镜像伪影。人物仿佛被轻微固定在空间中';

const ControlPanel = () => {
  // ── 从 store 读取节点状态 ──
  const nodes          = useStore((state) => state.nodes);
  const activeNodeId   = useStore((state) => state.activeNodeId);
  const setActiveNodeId = useStore((state) => state.setActiveNodeId);
  const requestSeek    = useStore((state) => state.requestSeek);
  const updateNode     = useStore((state) => state.updateNode);
  const removeNode     = useStore((state) => state.removeNode);
  const videoSrc       = useStore((state) => state.videoSrc);

  // 当前激活节点
  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;
  const croppedImage    = activeNode?.croppedImage ?? null;
  const interactionData = activeNode
    ? {
        videoSrc: useStore.getState().videoSrc,
        interactionTime: activeNode.interactionTime,
        cropArea: activeNode.cropArea,
        videoNaturalSize: activeNode.videoNaturalSize,
      }
    : null;
  const guidanceVideo  = activeNode?.guidanceVideo ?? null;
  const feedbackVideo  = activeNode?.feedbackVideo ?? null;
  const waitingVideo   = activeNode?.waitingVideo ?? null;
  const waitingList    = activeNode?.waitingList ?? [];
  const guidanceList   = activeNode?.guidanceList ?? [];
  const feedbackList   = activeNode?.feedbackList ?? [];

  // 追加一个新的等待视频并设为当前
  const addWaitingItem = () => {
    if (!activeNodeId) return;
    const newItem = {
      id: Date.now().toString() + '-w',
      videoUrl: null,
      method: 1,
      prompt: DEFAULT_WAITING_PROMPT,
      prompt2: DEFAULT_WAITING_PROMPT,
      duration: 5.0,
      duration1: 4.0,
      duration2: 5.0,
      transition_duration: 4.0,
      loop_duration: 8.0,
      loop_count: 2,
      hh_duration: 5,
      hh_resolution: '720P',
      split_time: 2.0,
    };
    updateNode(activeNodeId, { waitingList: [...waitingList, newItem] });
  };
  const removeWaitingItem = (id) => {
    if (!activeNodeId) return;
    const remaining = waitingList.filter(item => item.id !== id);
    const removed = waitingList.find(item => item.id === id);
    let newWaitingVideo = activeNode.waitingVideo;
    if (removed?.videoUrl === newWaitingVideo) {
      newWaitingVideo = remaining[0]?.videoUrl ?? null;
    }
    updateNode(activeNodeId, { waitingList: remaining, waitingVideo: newWaitingVideo });
  };
  const updateWaitingItem = (id, updates) => {
    if (!activeNodeId) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    const remaining = node.waitingList.map(item => item.id === id ? { ...item, ...updates } : item);
    let newWaitingVideo = node.waitingVideo;
    if (updates.hasOwnProperty('videoUrl') && updates.videoUrl === null) {
      const removedItem = node.waitingList.find(item => item.id === id);
      if (removedItem?.videoUrl === newWaitingVideo) {
        newWaitingVideo = null;
      }
    }
    updateNode(activeNodeId, { waitingList: remaining, waitingVideo: newWaitingVideo });
  };
  const selectWaitingVideo = (url) => {
    if (activeNodeId) updateNode(activeNodeId, { waitingVideo: url });
  };

  // 追加一个新的引导语并设为当前
  const addGuidanceItem = () => {
    if (!activeNodeId) return;
    const newItem = { id: Date.now().toString() + '-g', text: '', audio: null, videoUrl: null, prompt: '保持人脸一致，人物慢慢看向前方，倾听状态，身体幅度不要过大，自然呼吸态，轻微眨眼, 不能点头，保持镜头不动，画面色彩不变，consistent lighting, consistent color grading, stable exposure, matching the first and last frame flawlessly' };
    updateNode(activeNodeId, { guidanceList: [...guidanceList, newItem] });
  };
  const removeGuidanceItem = (id) => {
    if (!activeNodeId) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    const remaining = node.guidanceList.filter(item => item.id !== id);
    const removed = node.guidanceList.find(item => item.id === id);
    let newGuidanceVideo = node.guidanceVideo;
    if (removed?.videoUrl === newGuidanceVideo) {
      newGuidanceVideo = remaining[0]?.videoUrl ?? null;
    }
    updateNode(activeNodeId, { guidanceList: remaining, guidanceVideo: newGuidanceVideo });
  };
  const updateGuidanceItem = (id, updates) => {
    if (!activeNodeId) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    const remaining = node.guidanceList.map(item => item.id === id ? { ...item, ...updates } : item);
    let newGuidanceVideo = node.guidanceVideo;
    if (updates.hasOwnProperty('videoUrl') && updates.videoUrl === null) {
      const removedItem = node.guidanceList.find(item => item.id === id);
      if (removedItem?.videoUrl === newGuidanceVideo) {
        newGuidanceVideo = null;
      }
    }
    updateNode(activeNodeId, { guidanceList: remaining, guidanceVideo: newGuidanceVideo });
  };
  const selectGuidanceVideo = (url) => {
    if (activeNodeId) updateNode(activeNodeId, { guidanceVideo: url });
  };

  // 追加一个新的反馈语并设为当前
  const addFeedbackItem = () => {
    if (!activeNodeId) return;
    const newItem = { id: Date.now().toString() + '-f', text: '', audio: null, videoUrl: null, prompt: '保持人脸一致，人物慢慢看向前方，倾听状态，身体幅度不要过大，自然呼吸态，轻微眨眼, 不能点头，保持镜头不动，画面色彩不变，consistent lighting, consistent color grading, stable exposure, matching the first and last frame flawlessly' };
    updateNode(activeNodeId, { feedbackList: [...feedbackList, newItem] });
  };
  const removeFeedbackItem = (id) => {
    if (!activeNodeId) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    const remaining = node.feedbackList.filter(item => item.id !== id);
    const removed = node.feedbackList.find(item => item.id === id);
    let newFeedbackVideo = node.feedbackVideo;
    if (removed?.videoUrl === newFeedbackVideo) {
      newFeedbackVideo = remaining[0]?.videoUrl ?? null;
    }
    updateNode(activeNodeId, { feedbackList: remaining, feedbackVideo: newFeedbackVideo });
  };
  const updateFeedbackItem = (id, updates) => {
    if (!activeNodeId) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    const remaining = node.feedbackList.map(item => item.id === id ? { ...item, ...updates } : item);
    let newFeedbackVideo = node.feedbackVideo;
    if (updates.hasOwnProperty('videoUrl') && updates.videoUrl === null) {
      const removedItem = node.feedbackList.find(item => item.id === id);
      if (removedItem?.videoUrl === newFeedbackVideo) {
        newFeedbackVideo = null;
      }
    }
    updateNode(activeNodeId, { feedbackList: remaining, feedbackVideo: newFeedbackVideo });
  };
  const selectFeedbackVideo = (url) => {
    if (activeNodeId) updateNode(activeNodeId, { feedbackVideo: url });
  };

  const handleItemVideoUpload = (e, itemId, type) => {
    const file = e.target.files[0];
    if (file) {
      const videoUrl = URL.createObjectURL(file);
      if (type === 'guidance') {
        updateGuidanceItem(itemId, { videoUrl });
        if (!activeNode.guidanceVideo) selectGuidanceVideo(videoUrl);
      } else {
        updateFeedbackItem(itemId, { videoUrl });
        if (!activeNode.feedbackVideo) selectFeedbackVideo(videoUrl);
      }
    }
    if (e.target) e.target.value = null;
  };

  const globalRefText = '当然，这里呢主要结合了平移。如果你平移学的好啊，哎，做这个问题还是挺简单的。但是呢，我还是把题目读懂，哎，只要读懂了之后呢，很容易就做对了。';

  // ── FFmpeg 实例 (供提取音频使用) ──
  const ffmpegRef = useRef(new FFmpeg());
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoadingError, setFfmpegLoadingError] = useState(null);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const ffmpegLoadingRef = useRef(false);

  React.useEffect(() => {
    const loadFFmpeg = async () => {
      if (ffmpegLoadingRef.current || ffmpegLoaded) return;
      ffmpegLoadingRef.current = true;
      setFfmpegLoadingError(null);
      setFfmpegProgress(0);

      // 使用 jsdelivr 加速，或者国内镜像
      // const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      // const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
      const baseURL = window.location.origin + '/ffmpeg'; 
      const ffmpeg = ffmpegRef.current;
      
      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      ffmpeg.on('progress', ({ progress, time }) => {
        const p = Math.round(progress * 100);
        if (p >= 0 && p <= 100) {
           setFfmpegProgress(p);
        }
      });

      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        
        setFfmpegProgress(100);
        setFfmpegLoaded(true);
      } catch (err) {
        console.error('Failed to load FFmpeg:', err);
        setFfmpegLoadingError(err.message || '加载失败，请检查网络');
        ffmpegLoadingRef.current = false;
      }
    };
    loadFFmpeg();
  }, [ffmpegLoaded]);

  // ── 语音克隆 (TTS) 逻辑 ──
  const handleCloneVoice = async (item, type) => {
    if (!item.text) { alert('请输入待克隆的文本内容！'); return; }
    if (!videoSrc) { alert('当前节点未关联基础视频，无法提取参考音频！'); return; }
    if (!ffmpegLoaded) { alert('FFmpeg 尚未加载完成，请稍后再试！'); return; }

    setCloningId(item.id);
    try {
      // 1. 提取视频后15秒的音频作为 WAV 参考
      const ffmpeg = ffmpegRef.current;
      const videoData = await fetchFile(videoSrc);
      
      ffmpeg.writeFile('input.mp4', videoData);
      
      // 获取视频总时长 (简单起见，若能确定可以直接传参，这里假设能通过 FFprobe 获取或通过 HTMLVideoElement 获取)
      // 由于 FFprobe 在 ffmpeg.wasm 中的调用比较复杂，我们可以用一个临时 HTMLVideoElement 探测时长
      const duration = await new Promise((resolve) => {
        const tempVid = document.createElement('video');
        tempVid.src = videoSrc;
        tempVid.onloadedmetadata = () => resolve(tempVid.duration);
      });

      const startTime = Math.max(0, duration - 15);
      
      // 截取后15秒的音频，保存为 wav
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-ss', startTime.toString(),
        '-vn', // 不要视频流
        '-acodec', 'pcm_s16le', // 转换为 wav
        '-ar', '16000', // 16kHz
        '-ac', '1', // 单声道
        'ref_audio.wav'
      ]);

      const audioFileData = await ffmpeg.readFile('ref_audio.wav');
      const refAudioBlob = new Blob([audioFileData.buffer], { type: 'audio/wav' });
      const refAudioFile = new File([refAudioBlob], 'ref_audio.wav', { type: 'audio/wav' });

      // 2. 构造 FormData 并请求克隆
      const formData = new FormData();
      formData.append('text', item.text);
      formData.append('language', 'Chinese');
      formData.append('ref_audio', refAudioFile);

      const response = await fetch(getTtsCloneUrl(), {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        const audioData = { 
          file: new File([blob], `clone_${Date.now()}.wav`, { type: 'audio/wav' }), 
          url: audioUrl, 
          name: `克隆语音_${item.text.slice(0, 5)}...` 
        };
        
        if (type === 'guidance') {
          updateGuidanceItem(item.id, { audio: audioData });
        } else {
          updateFeedbackItem(item.id, { audio: audioData });
        }
      } else {
        const errorText = await response.text();
        alert(`语音克隆失败: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('TTS Clone Error:', error);
      alert('语音克隆发生错误，请检查控制台。');
    } finally {
      setCloningId(null);
    }
  };

  // ── 本地 UI 状态 ──
  const [generatingGuidanceId, setGeneratingGuidanceId] = useState(null);
  const [generatingFeedbackId, setGeneratingFeedbackId] = useState(null);
  const [cloningId, setCloningId] = useState(null);

  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');

  const [isBatchImportFeedbackOpen, setIsBatchImportFeedbackOpen] = useState(false);
  const [batchImportFeedbackText, setBatchImportFeedbackText] = useState('');
  const [isBatchCloning, setIsBatchCloning] = useState(false);
  const [batchCloningProgress, setBatchCloningProgress] = useState('');

  const handleBatchImportFeedback = async () => {
    const lines = batchImportFeedbackText.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length === 0) {
      alert('请输入有效的反馈语内容！');
      return;
    }
    if (!videoSrc) {
      alert('当前节点未关联基础视频，无法提取参考音频！');
      return;
    }
    if (!ffmpegLoaded) {
      alert('FFmpeg 尚未加载完成，请稍后再试！');
      return;
    }

    setIsBatchCloning(true);
    setBatchCloningProgress('正在初始化批量导入...');
    
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === activeNodeId);
    if (!node) return;
    
    const validCurrentList = node.feedbackList.filter(item => item.text || item.audio || item.videoUrl);

    const newItems = lines.map((text, idx) => ({
      id: Date.now().toString() + '-batch-' + idx + '-f',
      text,
      audio: null,
      videoUrl: null
    }));

    const combinedList = [...validCurrentList, ...newItems];
    updateNode(activeNodeId, { feedbackList: combinedList });
    
    setIsBatchImportFeedbackOpen(false);
    setBatchImportFeedbackText('');

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      setBatchCloningProgress(`正在克隆 (${i + 1}/${newItems.length})...`);
      await handleCloneVoice(item, 'feedback');
    }

    setIsBatchCloning(false);
    setBatchCloningProgress('');
  };

  const guidanceInputRef = useRef(null);
  const feedbackInputRef = useRef(null);

  const waitingVideoInputRef  = useRef(null);
  const guidanceVideoInputRef = useRef(null);
  const feedbackVideoInputRef = useRef(null);

  // ─────────────────────── 工具函数 ───────────────────────
  const handleVideoUpload = (e, setVideo) => {
    const file = e.target.files[0];
    if (file) {
      const videoUrl = URL.createObjectURL(file);
      setVideo(videoUrl);
    }
    if (e.target) e.target.value = null;
  };

  const handleAudioUpload = (e, setAudio) => {
    const file = e.target.files[0];
    if (file) {
      const audioUrl = URL.createObjectURL(file);
      setAudio({ file, url: audioUrl, name: file.name });
    }
    e.target.value = null;
  };

  const clearAudio = (setAudio, currentAudio) => {
    if (currentAudio?.url) URL.revokeObjectURL(currentAudio.url);
    setAudio(null);
  };

  const processImage = async (blob) => {
    return blob;
  };

  const processVideoSegment = async (iData, type = 'forward') => {
    if (!iData || !iData.videoSrc) {
      throw new Error('未获取到视频信息，请先在视频处理区域选取视频帧！');
    }

    if (!ffmpegLoaded) {
      throw new Error('FFmpeg 尚未加载完成，请稍后再试！');
    }

    const ffmpeg = ffmpegRef.current;

    const inputName = 'input.mp4';
    const outputName = 'output.mp4';

    await ffmpeg.writeFile(inputName, await fetchFile(iData.videoSrc));

    const startTime = iData.interactionTime;

    let cropFilter = '';
    if (iData.cropArea) {
      const { width, height, x, y } = iData.cropArea;
      cropFilter = `crop=${width}:${height}:${x}:${y}`;
    }

    if (type === 'forward') {
      const args = ['-y', '-ss', `${startTime}`, '-t', '10', '-i', inputName, '-an'];
      if (cropFilter) args.push('-vf', cropFilter);
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', outputName);
      await ffmpeg.exec(args);
    } else if (type === 'reverse') {
      const args = ['-y', '-ss', `${startTime}`, '-t', '10', '-i', inputName, '-an'];
      if (cropFilter) {
        args.push('-vf', `${cropFilter},reverse`);
      } else {
        args.push('-vf', 'reverse');
      }
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', outputName);
      await ffmpeg.exec(args);
    }

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
  };

  const generateVideo = async (audioFile, imageBlob, setVideo, setIsGenerating, endpoint = '/generate', customPrompt = null) => {
    if (!imageBlob) { alert('请先裁剪图片！'); return; }
    setIsGenerating(true);

    let processedImageBlob = imageBlob;
    try {
      processedImageBlob = await processImage(imageBlob);
    } catch (error) {
      console.error('Image processing failed:', error);
      alert('图片处理失败');
      setIsGenerating(false);
      return;
    }

    const formData = new FormData();
    formData.append('image_file', processedImageBlob, 'image.png');

    if (audioFile) {
      formData.append('audio_file', audioFile);
    } else {
      try {
        const response = await fetch('/empty.aac');
        const blob = await response.blob();
        formData.append('audio_file', blob, 'empty.aac');
      } catch (error) {
        console.error('Failed to load empty.aac:', error);
        alert('无法加载默认音频文件');
        setIsGenerating(false);
        return;
      }
    }

    formData.append('prompt', customPrompt || '保持人脸一致，人物慢慢看向前方，倾听状态，身体幅度不要过大，自然呼吸态，轻微眨眼, 不能点头，保持镜头不动，画面色彩不变，consistent lighting, consistent color grading, stable exposure, matching the first and last frame flawlessly');
    formData.append('seed', 9999);
    formData.append('audio_encode_mode', 'stream');

    const apiUrl = getGenerateVideoUrl(endpoint);
      console.log(`Calling logic at`, apiUrl);

      try {
        const response = await fetch(apiUrl, { method: 'POST', body: formData });
      if (response.ok) {
        if (endpoint === '/generate_boomerang') {
          const blob = await response.blob();
          try {
            const zip = await JSZip.loadAsync(blob);
            const forwardFile = zip.file('forward.mp4');
            const reverseFile = zip.file('reverse.mp4');
            let forwardUrl = null, reverseUrl = null;
            if (forwardFile) forwardUrl = URL.createObjectURL(new Blob([await forwardFile.async('arraybuffer')], { type: 'video/mp4' }));
            if (reverseFile) reverseUrl = URL.createObjectURL(new Blob([await reverseFile.async('arraybuffer')], { type: 'video/mp4' }));
            setVideo({ forward: forwardUrl, reverse: reverseUrl });
          } catch (zipErr) {
            // 如果不是 ZIP 格式，可能后端只是返回了一个普通的 mp4
            console.warn('Response is not a valid zip file, treating as single video:', zipErr);
            const videoUrl = URL.createObjectURL(blob);
            setVideo({ forward: videoUrl, reverse: videoUrl }); // 如果只有单视频，则正放和倒放都使用同一个
          }
        } else {
          const videoUrl = URL.createObjectURL(await response.blob());
          setVideo(videoUrl);
        }
      } else {
        const errorText = await response.text();
        console.error('Generation failed:', errorText);
        alert(`生成失败: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error generating video:', error);
      alert('生成请求发生错误，请检查控制台。');
    } finally {
      setIsGenerating(false);
    }
  };

  const generateSyncVideo = async (audioFile, waitingVideoState, setVideo, setIsGenerating) => {
    if (!waitingVideoState) { alert('请先生成或上传等待视频！'); return; }
    setIsGenerating(true);
    try {
      let forwardBlob, reverseBlob;
      if (typeof waitingVideoState === 'object' && waitingVideoState.original) {
        const singleBlob = await fetch(waitingVideoState.original).then(r => r.blob());
        forwardBlob = singleBlob;
        reverseBlob = singleBlob;
      } else if (typeof waitingVideoState === 'object' && waitingVideoState.forward && waitingVideoState.reverse) {
        forwardBlob = await fetch(waitingVideoState.forward).then(r => r.blob());
        reverseBlob = await fetch(waitingVideoState.reverse).then(r => r.blob());
      } else if (typeof waitingVideoState === 'string') {
        const singleBlob = await fetch(waitingVideoState).then(r => r.blob());
        forwardBlob = singleBlob;
        reverseBlob = singleBlob;
      } else {
        alert('等待视频格式不支持');
        setIsGenerating(false);
        return;
      }

      const formData = new FormData();
      formData.append('video_forward', forwardBlob, 'forward.mp4');
      formData.append('video_reverse', reverseBlob, 'reverse.mp4');
      formData.append('audio', audioFile, audioFile.name || 'audio.wav');
      formData.append('guidance_scale', '1.5');
      formData.append('inference_steps', '20');
      formData.append('seed', '42');

      const apiUrl = getSyncVideoUrl();
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'X-Token': 'theta-xizhi' },
        body: formData,
      });

      if (response.ok) {
        setVideo(URL.createObjectURL(await response.blob()));
      } else {
        let errorText = await response.text();
        try { errorText = JSON.parse(errorText).detail || errorText; } catch (e) {}
        alert(`生成失败: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('Error generating video:', error);
      alert('生成请求发生错误，请检查控制台。');
    } finally {
      setIsGenerating(false);
    }
  };

  const generateLipSyncVideo = async (audioFile, startTime, setVideo, setIsGenerating, isBackward = false) => {
    if (!videoSrc) {
      alert('请先在左侧选择或上传视频');
      return;
    }
    setIsGenerating(true);
    try {
      // 1. 获取音频时长
      const audioUrl = URL.createObjectURL(audioFile);
      const audioDuration = await new Promise((resolve) => {
        const audio = new Audio(audioUrl);
        audio.addEventListener('loadedmetadata', () => {
          resolve(audio.duration);
        });
      });
      URL.revokeObjectURL(audioUrl);
      // 2. 从原视频裁剪出所需片段 (包含空间裁剪)
      let sliceBlob;
      if (isBackward) {
        sliceBlob = await cutBackwardBoomerangVideoSegment({
          videoSrc: videoSrc,
          startTime: startTime,
          duration: - (audioDuration / 2),
          cropArea: activeNode?.cropArea,
          videoNaturalSize: activeNode?.videoNaturalSize,
          onLog: (msg) => console.log(`[FFmpeg Backward Slice LipSync]`, msg)
        });
      } else {
        sliceBlob = await cutBoomerangVideoSegment({
          videoSrc: videoSrc,
          startTime: startTime,
          duration: audioDuration / 2,
          cropArea: activeNode?.cropArea,
          videoNaturalSize: activeNode?.videoNaturalSize,
          onLog: (msg) => console.log(`[FFmpeg Slice LipSync]`, msg)
        });
      }

      // 3. 调用后端对口型接口
      const formData = new FormData();
      formData.append('video', sliceBlob, 'video.mp4');
      formData.append('audio', audioFile, audioFile.name || 'audio.wav');
      formData.append('token', 'theta-xizhi');
      formData.append('guidance_scale', '1.5');
      formData.append('inference_steps', '20');
      formData.append('seed', '42');

      const apiUrl = getLipSyncUrl();
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        setVideo(URL.createObjectURL(await response.blob()));
      } else {
        let errorText = await response.text();
        try { errorText = JSON.parse(errorText).detail || errorText; } catch (e) {}
        alert(`对口型视频生成失败: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('Error generating lip sync video:', error);
      alert('生成对口型视频请求发生错误，请检查控制台。');
    } finally {
      setIsGenerating(false);
    }
  };

  // ─────────────────────── 业务操作 ───────────────────────
  const handleGenerateGuidance = async (item) => {
    if (!item.audio) return;
    setGeneratingGuidanceId(item.id);
    await generateLipSyncVideo(item.audio.file, activeNode?.interactionTime || 0, (url) => {
      updateGuidanceItem(item.id, { videoUrl: url });
      if (!activeNode.guidanceVideo) selectGuidanceVideo(url);
    }, () => {});
    setGeneratingGuidanceId(null);
  };

  const handleGenerateFeedback = async (item) => {
    if (!item.audio) return;
    setGeneratingFeedbackId(item.id);
    await generateLipSyncVideo(item.audio.file, activeNode?.interactionTime || 0, (url) => {
      updateFeedbackItem(item.id, { videoUrl: url });
      if (!activeNode.feedbackVideo) selectFeedbackVideo(url);
    }, () => {}, item.isBackward); // 传入 isBackward
    setGeneratingFeedbackId(null);
  };

  const [generatingWaitingId, setGeneratingWaitingId] = useState(null);

  const handleGenerateWaiting = async (item) => {
    setGeneratingWaitingId(item.id);

    const nodeFrameBlob = croppedImage;
    const refFrameBlob = useStore.getState().globalReferenceFrame;
    const waitingType = item.method || 1;

    // 校验必要输入
    const NEED_NODE = [1, 2, 3, 5, 7, 8];
    const NEED_REF = [2, 3, 4, 5, 6, 7, 9];

    if (NEED_NODE.includes(waitingType) && !nodeFrameBlob) {
      alert('节点帧不存在，请重新添加该节点！');
      setGeneratingWaitingId(null);
      return;
    }
    if (NEED_REF.includes(waitingType) && !refFrameBlob) {
      alert('缺少参考帧，请先设置参考帧！');
      setGeneratingWaitingId(null);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('waiting_type', String(waitingType));

      if (nodeFrameBlob && NEED_NODE.includes(waitingType)) {
        formData.append('node_frame', nodeFrameBlob, 'node_frame.png');
      }
      if (refFrameBlob && NEED_REF.includes(waitingType)) {
        formData.append('ref_frame', refFrameBlob, 'ref_frame.png');
      }
      if (item.prompt) formData.append('prompt', item.prompt);

      // Type-specific params
      if (waitingType === 3) {
        if (item.prompt2) formData.append('prompt2', item.prompt2);
        formData.append('duration1', String(item.duration1 || 4.0));
        formData.append('duration2', String(item.duration2 || 5.0));
      }
      if ([2, 4, 5, 6].includes(waitingType)) {
        formData.append('duration', String(item.duration || (waitingType >= 5 ? 10.0 : 5.0)));
      }
      if (waitingType === 7) {
        formData.append('transition_duration', String(item.transition_duration || 4.0));
        formData.append('loop_duration', String(item.loop_duration || 8.0));
        formData.append('loop_count', String(item.loop_count || 2));
      }
      if ([8, 9].includes(waitingType)) {
        formData.append('hh_duration', String(item.hh_duration || 5));
        formData.append('hh_resolution', item.hh_resolution || '720P');
      }
      formData.append('split_time', String(item.split_time || 2.0));

      const response = await fetch(getWaitingGenUrl(), { method: 'POST', body: formData });

      if (response.ok) {
        const zipBlob = await response.blob();
        const zip = await JSZip.loadAsync(zipBlob);

        const originalBlob = new Blob([await zip.file('original.mp4').async('arraybuffer')], { type: 'video/mp4' });
        const first2sBlob = new Blob([await zip.file('first2s.mp4').async('arraybuffer')], { type: 'video/mp4' });
        const restBlob = new Blob([await zip.file('rest.mp4').async('arraybuffer')], { type: 'video/mp4' });
        const first2sRevBlob = new Blob([await zip.file('first2sRev.mp4').async('arraybuffer')], { type: 'video/mp4' });

        const waitingData = {
          original: URL.createObjectURL(originalBlob),
          first2s: URL.createObjectURL(first2sBlob),
          rest: URL.createObjectURL(restBlob),
          first2sRev: URL.createObjectURL(first2sRevBlob),
        };

        updateWaitingItem(item.id, { videoUrl: waitingData });
        if (!activeNode.waitingVideo) selectWaitingVideo(waitingData);
      } else {
        const errorText = await response.text();
        console.error('Waiting generation failed:', errorText);
        alert(`等待态生成失败: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('Error generating waiting video:', error);
      alert('生成请求发生错误，请检查控制台。');
    }

    setGeneratingWaitingId(null);
  };

  const handleBatchGenerateMerge = async () => {
    const validGuidances = guidanceList.filter(g => g.audio);
    const validFeedbacks = feedbackList.filter(f => f.audio);

    if (validGuidances.length === 0 || validFeedbacks.length === 0) {
      alert('请至少上传或生成一个引导语音频和一个反馈语音频！');
      return;
    }
    if (!interactionData?.videoSrc) {
      alert('请先在左侧视频处理区域选取视频帧！');
      return;
    }

    setIsBatchGenerating(true);
    setBatchProgress('正在提取视频片段...');
    try {
      let segmentUrl;
      try {
        segmentUrl = await processVideoSegment(interactionData, 'forward');
      } catch (error) {
        console.error('Video segmentation failed:', error);
        alert('提取视频片段失败：' + error.message);
        setIsBatchGenerating(false);
        return;
      }

      const videoBlob = await fetch(segmentUrl).then(r => r.blob());

      let total = validGuidances.length * validFeedbacks.length;
      let current = 0;

      for (let i = 0; i < validGuidances.length; i++) {
        for (let j = 0; j < validFeedbacks.length; j++) {
          current++;
          const gItem = validGuidances[i];
          const fItem = validFeedbacks[j];
          
          setBatchProgress(`正在生成组合 ${current}/${total} (引导语${i+1}-反馈语${j+1})...`);

          const formData = new FormData();
          formData.append('video', videoBlob, 'video.mp4');
          formData.append('audio1', gItem.audio.file, gItem.audio.file.name || 'guidance.wav');
          formData.append('audio2', fItem.audio.file, fItem.audio.file.name || 'feedback.wav');

          const apiUrl = getMergeGenUrl();
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'X-Token': 'theta-xizhi' },
            body: formData,
          });

          if (response.ok) {
            const blob = await response.blob();
            const zip = await JSZip.loadAsync(blob);
            let generatedWaiting = null, generatedGuidance = null, generatedFeedback = null;
            const files = Object.keys(zip.files).filter(name => !zip.files[name].dir && name.endsWith('.mp4'));

            for (let name of files) {
              const fileBlob = new Blob([await zip.files[name].async('arraybuffer')], { type: 'video/mp4' });
              const url = URL.createObjectURL(fileBlob);
              const lowerName = name.toLowerCase();
              if (lowerName.includes('loop'))      generatedWaiting  = url;
              else if (lowerName.includes('part1')) generatedGuidance = url;
              else if (lowerName.includes('part2')) generatedFeedback = url;
              else {
                if (!generatedWaiting)       generatedWaiting  = url;
                else if (!generatedGuidance) generatedGuidance = url;
                else if (!generatedFeedback) generatedFeedback = url;
              }
            }

            const newResultItem = {
              id: `combo-${gItem.id}-${fItem.id}-${Date.now()}`,
              title: `引导语${i+1}-反馈语${j+1}`,
              waitingVideo: generatedWaiting,
              guidanceVideo: generatedGuidance,
              feedbackVideo: generatedFeedback,
              guidanceId: gItem.id,
              feedbackId: fItem.id
            };

            // 实时更新 Zustand 状态，确保获取到最新结果列表
            const state = useStore.getState();
            const currentNode = state.nodes.find(n => n.id === activeNodeId);
            if (currentNode) {
              const existingResults = currentNode.mergedResults || [];
              updateNode(activeNodeId, { mergedResults: [...existingResults, newResultItem] });
            }

          } else {
            console.error(`组合 引导语${i+1}-反馈语${j+1} 生成失败`);
          }
        }
      }

      setBatchProgress('生成完成！');
      setTimeout(() => setBatchProgress(''), 3000);

    } catch (error) {
      console.error('Error generating batch merge video:', error);
      alert('生成请求发生错误，请检查控制台。');
      setBatchProgress('');
    } finally {
      setIsBatchGenerating(false);
    }
  };

  // ─────────────────────── 渲染辅助 ───────────────────────
  const renderAudioInputItem = (item, updateItem, onAudioChange, onClear, isGenerating, onGenerate, colorClass, buttonColorClass, showGenerateButton = true, showPrompt = false) => {
    const inputId = `audio-input-${Math.random().toString(36).substr(2, 9)}`;
    const audioState = item.audio;
    return (
      <div className="flex flex-col gap-3 mb-3">
        {showPrompt && (
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-1">生成提示词 (Prompt)</label>
            <textarea
              value={item.prompt || '保持人脸一致，人物慢慢看向前方，倾听状态，身体幅度不要过大，自然呼吸态，轻微眨眼, 不能点头，保持镜头不动，画面色彩不变，consistent lighting, consistent color grading, stable exposure, matching the first and last frame flawlessly'}
              onChange={(e) => updateItem(item.id, { prompt: e.target.value })}
              placeholder="输入画面生成提示词..."
              className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all resize-none"
              rows={2}
            />
          </div>
        )}

        {!audioState ? (
          <>
            <label
              htmlFor={inputId}
              className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors group"
            >
              <Upload className={`w-4 h-4 ${colorClass} group-hover:scale-110 transition-transform`} />
              <span className="text-xs text-slate-500 font-medium">点击上传音频</span>
            </label>
            <input
              id={inputId}
              type="file"
              onChange={onAudioChange}
              accept="audio/*"
              className="hidden"
            />
          </>
        ) : (
          <div className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
            <div className={`p-1.5 bg-white rounded-full shadow-sm ${colorClass}`}>
              <Music className="w-3 h-3" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium text-slate-700 truncate mb-0.5">{audioState.name}</p>
              <audio controls src={audioState.url} className="w-full h-5 block" />
            </div>
            <button
              onClick={onClear}
              className="p-1 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {showGenerateButton && (
          <button
            onClick={onGenerate}
            disabled={isGenerating}
            className={`w-full py-1.5 ${buttonColorClass} disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5`}
          >
            {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            开始生成
          </button>
        )}
      </div>
    );
  };

  // ─────────────────────── JSX ───────────────────────
  const globalReferenceFrame = useStore((state) => state.globalReferenceFrame);

  const avatarUrl = React.useMemo(() => {
    if (!globalReferenceFrame) return null;
    return URL.createObjectURL(globalReferenceFrame);
  }, [globalReferenceFrame]);

  const [nodeFrameUrl, setNodeFrameUrl] = useState(null);

  React.useEffect(() => {
    return () => { 
      if (avatarUrl) URL.revokeObjectURL(avatarUrl); 
    };
  }, [avatarUrl]);

  React.useEffect(() => {
    if (!activeNode || !croppedImage) {
      setNodeFrameUrl(null);
      return;
    }
    
    // 直接使用 store 中已经截取好的 croppedImage，避免每次切换/添加节点时都启动 FFmpeg WASM 导致内存泄漏和崩溃
    const url = URL.createObjectURL(croppedImage);
    setNodeFrameUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [activeNode, croppedImage]);

  const sortedNodes = [...nodes].sort((a, b) => a.interactionTime - b.interactionTime);

  const formatTimePrecise = (t) => {
    if (!t || isNaN(t)) return '00:00.00';
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
  };

  const exportAllNodes = async (compositeVideo = false) => {
    if (sortedNodes.length === 0) {
      alert('没有可导出的节点数据！');
      return;
    }
    
    setIsExporting(true);
    setExportProgress('正在准备数据...');
    try {
      const { globalCropArea, globalVideoNaturalSize, globalReferenceFrame, globalReferenceFrameTime } = useStore.getState();
      let zipBlob = await exportProjectToZip({
        videoSrc,
        nodes: sortedNodes,
        globalCropArea,
        globalVideoNaturalSize,
        globalReferenceFrame,
        globalReferenceFrameTime,
        onProgress: (msg) => {
          setExportProgress(msg);
          console.log(msg);
        }
      });
      
      if (compositeVideo) {
        setExportProgress('正在后端合成全画幅视频...');
        const formData = new FormData();
        // 将前端打包好的 zip 作为 file 字段上传给后端
        formData.append('file', zipBlob, 'temp_project.zip');
        
        const res = await fetch(getExportCompositeUrl(), {
          method: 'POST',
          body: formData,
        });
        
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || '后端合成失败');
        }
        
        zipBlob = await res.blob();
      }
      
      setExportProgress('生成下载链接...');
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project_export_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportProgress('导出完成');
    } catch (e) {
      console.error(e);
      alert('导出失败: ' + e.message);
    } finally {
      setTimeout(() => {
        setIsExporting(false);
        setExportProgress('');
      }, 1000);
    }
  };

  const handleImportZip = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setIsImporting(true);
    setImportProgress('开始导入...');
    try {
      const projectState = await importProjectFromZip(file, (msg) => {
        setImportProgress(msg);
        console.log(msg);
      });
      useStore.getState().loadProjectState(projectState);
      setImportProgress('导入完成');
    } catch (err) {
      console.error(err);
      alert('工程导入失败: ' + err.message);
    } finally {
      setTimeout(() => {
        setIsImporting(false);
        setImportProgress('');
      }, 1000);
    }
    if (e.target) e.target.value = null;
  };

  return (
    <div className="flex flex-col gap-6 h-full p-4 overflow-y-auto bg-slate-50/50">

      {/* ── FFmpeg 加载状态 ── */}
      {!ffmpegLoaded && !ffmpegLoadingError && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700 shadow-sm flex flex-col gap-3">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="font-medium">FFmpeg 组件正在加载中（初次加载需下载约 30MB 核心文件），请耐心等待...</span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
            <div 
              className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out" 
              style={{ width: `${ffmpegProgress}%` }}
            ></div>
          </div>
          <div className="text-right text-xs text-blue-600 font-mono">
            {ffmpegProgress}%
          </div>
        </div>
      )}
      {ffmpegLoadingError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex flex-col items-center gap-2 shadow-sm">
          <span className="font-medium">FFmpeg 加载失败: {ffmpegLoadingError}</span>
          <button 
            onClick={() => { ffmpegLoadingRef.current = false; setFfmpegLoaded(false); }} 
            className="px-4 py-1.5 bg-red-600 hover:bg-red-700 transition-colors text-white rounded-md text-xs"
          >
            重试加载
          </button>
        </div>
      )}

      {/* ── 节点选择器 ── */}
      <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-100">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-slate-500">选择交互节点</p>
          <div className="flex items-center gap-2">
            <label 
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${isImporting ? 'bg-blue-100 text-blue-400 cursor-not-allowed' : 'text-blue-600 hover:text-blue-800 hover:bg-blue-50 cursor-pointer'}`}
              title="导入工程 ZIP"
            >
              {isImporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              {isImporting ? importProgress : '导入'}
              <input type="file" accept=".zip" onChange={handleImportZip} className="hidden" disabled={isImporting} />
            </label>
            <div className="relative group">
              <button
                disabled={isExporting || nodes.length === 0}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${isExporting ? 'bg-blue-100 text-blue-400 cursor-not-allowed' : 'text-blue-600 hover:text-blue-800 hover:bg-blue-50'}`}
              >
                {isExporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                {isExporting ? exportProgress : '导出选项'}
                <ChevronDown className="w-3 h-3" />
              </button>
              
              {!isExporting && nodes.length > 0 && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-white border border-slate-200 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                  <div className="p-1 flex flex-col gap-1">
                    <button
                      onClick={() => exportAllNodes(false)}
                      className="text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                      title="导出仅包含裁剪区域的小尺寸视频"
                    >
                      导出原始视频 (默认)
                    </button>
                    <button
                      onClick={() => exportAllNodes(true)}
                      className="text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                      title="导出包含全画幅背景合成的完整视频"
                    >
                      导出全画幅合成视频
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {nodes.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {sortedNodes.map((node, i) => (
              <button
                key={node.id}
                onClick={() => {
                  setActiveNodeId(node.id);
                  requestSeek(Math.max(0, node.interactionTime - 1));
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  activeNodeId === node.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                  activeNodeId === node.id ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-500'
                }`}>
                  #{i + 1}
                </span>
                <span className="font-mono font-medium flex-1">{formatTimePrecise(node.interactionTime)}s</span>
                <div className="flex items-center gap-1.5">
                  {node.waitingVideo   && <span className={`w-1.5 h-1.5 rounded-full ${activeNodeId === node.id ? 'bg-orange-300' : 'bg-orange-400'}`} title="等待视频已就绪" />}
                  {node.guidanceVideo  && <span className={`w-1.5 h-1.5 rounded-full ${activeNodeId === node.id ? 'bg-blue-300' : 'bg-blue-500'}`} title="引导语视频已就绪" />}
                  {node.feedbackVideo  && <span className={`w-1.5 h-1.5 rounded-full ${activeNodeId === node.id ? 'bg-purple-300' : 'bg-purple-500'}`} title="反馈语视频已就绪" />}
                </div>
                <div className="flex items-center ml-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // 阻止触发外层 button 的 onClick
                      if (window.confirm('确定要删除此交互节点吗？')) {
                        removeNode(node.id);
                      }
                    }}
                    className={`p-1.5 rounded-md transition-colors ${activeNodeId === node.id ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
                    title="删除节点"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-center py-2 text-xs text-slate-400">
            暂无交互节点，请在左侧添加
          </div>
        )}
      </div>

      {/* Current Avatar Preview */}
      {croppedImage && activeNode && (
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="flex gap-2">
            <div className="flex flex-col items-center gap-1">
              <div className="w-16 h-16 rounded-lg overflow-hidden border border-slate-200 bg-slate-50 flex-shrink-0 relative group">
                <img src={avatarUrl} alt="参考帧" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white text-[10px] font-medium">参考帧</div>
              </div>
            </div>
            {nodeFrameUrl && (
              <div className="flex flex-col items-center gap-1">
                <div className="w-16 h-16 rounded-lg overflow-hidden border border-slate-200 bg-slate-50 flex-shrink-0 relative group">
                  <img src={nodeFrameUrl} alt="节点帧" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white text-[10px] font-medium">节点帧</div>
                </div>
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-slate-800 mb-1">参考帧 & 节点帧</h3>
            <div className="flex items-center gap-2">
              <p className="text-[10px] text-slate-400">时间点: </p>
              <span className="text-[10px] font-mono font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
                {formatTimePrecise(activeNode.interactionTime)}s
              </span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">生成任务将基于此裁剪区域</p>
          </div>
          <div className="px-2 py-1 bg-emerald-50 text-emerald-600 rounded text-[10px] font-bold border border-emerald-100 flex flex-col items-center gap-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            已就绪
          </div>
        </div>
      )}

      {/* 无激活节点时，其余部分禁用 */}
      {!activeNode && nodes.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700 text-center">
          请先选择一个交互节点以进行视频生成
        </div>
      )}

      {activeNode && (
        <>

          {/* Guidance Section */}
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-blue-500" />
                引导语生成
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={addGuidanceItem}
                  className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <Upload className="w-3 h-3" />
                  新增引导语
                </button>
              </div>
            </div>

            <div className="flex overflow-x-auto gap-4 pb-2 snap-x">
              {guidanceList.map((item, idx) => (
                <div key={item.id} className="min-w-[280px] w-[280px] flex-shrink-0 bg-slate-50 border border-slate-200 rounded-lg p-4 snap-center flex flex-col gap-3 relative">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500">引导语 {idx + 1}</span>
                    <div className="flex items-center gap-2">
                      {guidanceVideo === item.videoUrl && item.videoUrl && (
                        <span className="text-[10px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full font-bold">
                          当前使用
                        </span>
                      )}
                      <label className="cursor-pointer p-1 hover:bg-blue-100 rounded-md transition-colors text-blue-500" title="上传视频">
                        <Upload className="w-3.5 h-3.5" />
                        <input
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => handleItemVideoUpload(e, item.id, 'guidance')}
                        />
                      </label>
                      {guidanceList.length > 1 && (
                        <button
                          onClick={() => removeGuidanceItem(item.id)}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-medium text-slate-500 mb-1">文本内容</label>
                    <textarea
                      value={item.text}
                      onChange={(e) => updateGuidanceItem(item.id, { text: e.target.value })}
                      placeholder="请输入引导语文本..."
                      className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all resize-none"
                      rows={2}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[10px] font-medium text-slate-500">音频文件</label>
                      <button 
                        onClick={() => handleCloneVoice(item, 'guidance')}
                        disabled={cloningId === item.id || !item.text || !videoSrc}
                        className="flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-800 disabled:text-slate-400 font-medium transition-colors"
                      >
                        {cloningId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />}
                        生成克隆语音
                      </button>
                    </div>
                    {renderAudioInputItem(
                      item,
                      updateGuidanceItem,
                      (e) => handleAudioUpload(e, (audio) => updateGuidanceItem(item.id, { audio })),
                      () => clearAudio((audio) => updateGuidanceItem(item.id, { audio }), item.audio),
                      generatingGuidanceId === item.id,
                      () => handleGenerateGuidance(item),
                      'text-blue-500', 'bg-blue-600 hover:bg-blue-700',
                      true,
                      false // hide prompt
                    )}
                  </div>

                  {item.videoUrl && (
                    <div className="mt-auto">
                      <label className="block text-[10px] font-medium text-slate-500 mb-1">视频预览</label>
                      <div className="aspect-video bg-slate-900 rounded-lg overflow-hidden relative group/vid">
                        <video controls src={item.videoUrl} className="w-full h-full object-contain" />
                        <button
                          onClick={() => updateGuidanceItem(item.id, { videoUrl: null })}
                          className="absolute top-1 right-1 p-1 bg-red-500/80 hover:bg-red-600 text-white rounded-md opacity-0 group-hover/vid:opacity-100 transition-opacity"
                          title="清除视频"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {guidanceVideo !== item.videoUrl && (
                        <button
                          onClick={() => selectGuidanceVideo(item.videoUrl)}
                          className="w-full mt-2 py-1.5 bg-white border border-blue-200 text-blue-600 hover:bg-blue-50 rounded-lg text-xs font-medium transition-colors"
                        >
                          设为当前播放
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Feedback Section */}
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-500" />
                反馈语生成
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsBatchImportFeedbackOpen(true)}
                  disabled={isBatchCloning}
                  className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-600 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isBatchCloning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  {isBatchCloning ? batchCloningProgress : '批量导入并克隆'}
                </button>
                <button
                  onClick={addFeedbackItem}
                  disabled={isBatchCloning}
                  className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-600 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Upload className="w-3 h-3" />
                  新增反馈语
                </button>
              </div>
            </div>

            <div className="flex overflow-x-auto gap-4 pb-2 snap-x">
              {feedbackList.map((item, idx) => (
                <div key={item.id} className="min-w-[280px] w-[280px] flex-shrink-0 bg-slate-50 border border-slate-200 rounded-lg p-4 snap-center flex flex-col gap-3 relative">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500">反馈语 {idx + 1}</span>
                    <div className="flex items-center gap-2">
                      {feedbackVideo === item.videoUrl && item.videoUrl && (
                        <span className="text-[10px] bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full font-bold">
                          当前使用
                        </span>
                      )}
                      <label className="cursor-pointer p-1 hover:bg-purple-100 rounded-md transition-colors text-purple-500" title="上传视频">
                        <Upload className="w-3.5 h-3.5" />
                        <input
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => handleItemVideoUpload(e, item.id, 'feedback')}
                        />
                      </label>
                      {feedbackList.length > 1 && (
                        <button
                          onClick={() => removeFeedbackItem(item.id)}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-medium text-slate-500 mb-1">文本内容</label>
                    <textarea
                      value={item.text}
                      onChange={(e) => updateFeedbackItem(item.id, { text: e.target.value })}
                      placeholder="请输入反馈语文本..."
                      className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all resize-none"
                      rows={2}
                    />
                  </div>

                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[10px] font-medium text-slate-500">生成参数</label>
                  </div>
                  <div className="flex items-center gap-3 mb-2">
                    <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-600">
                      <input
                        type="radio"
                        name={`direction-${item.id}`}
                        checked={!item.isBackward}
                        onChange={() => updateFeedbackItem(item.id, { isBackward: false })}
                        className="text-purple-500 focus:ring-purple-500"
                      />
                      向后取视频 (默认)
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-600">
                      <input
                        type="radio"
                        name={`direction-${item.id}`}
                        checked={item.isBackward}
                        onChange={() => updateFeedbackItem(item.id, { isBackward: true })}
                        className="text-purple-500 focus:ring-purple-500"
                      />
                      向前取视频并反转
                    </label>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[10px] font-medium text-slate-500">音频文件</label>
                      <button 
                        onClick={() => handleCloneVoice(item, 'feedback')}
                        disabled={cloningId === item.id || !item.text || !videoSrc}
                        className="flex items-center gap-1 text-[10px] text-purple-600 hover:text-purple-800 disabled:text-slate-400 font-medium transition-colors"
                      >
                        {cloningId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />}
                        生成克隆语音
                      </button>
                    </div>
                    {renderAudioInputItem(
                      item,
                      updateFeedbackItem,
                      (e) => handleAudioUpload(e, (audio) => updateFeedbackItem(item.id, { audio })),
                      () => clearAudio((audio) => updateFeedbackItem(item.id, { audio }), item.audio),
                      generatingFeedbackId === item.id,
                      () => handleGenerateFeedback(item),
                      'text-purple-500', 'bg-purple-600 hover:bg-purple-700',
                      true,
                      false // hide prompt
                    )}
                  </div>

                  {item.videoUrl && (
                    <div className="mt-auto">
                      <label className="block text-[10px] font-medium text-slate-500 mb-1">视频预览</label>
                      <div className="aspect-video bg-slate-900 rounded-lg overflow-hidden relative group/vid">
                        <video controls src={item.videoUrl} className="w-full h-full object-contain" />
                        <button
                          onClick={() => updateFeedbackItem(item.id, { videoUrl: null })}
                          className="absolute top-1 right-1 p-1 bg-red-500/80 hover:bg-red-600 text-white rounded-md opacity-0 group-hover/vid:opacity-100 transition-opacity"
                          title="清除视频"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {feedbackVideo !== item.videoUrl && (
                        <button
                          onClick={() => selectFeedbackVideo(item.videoUrl)}
                          className="w-full mt-2 py-1.5 bg-white border border-purple-200 text-purple-600 hover:bg-purple-50 rounded-lg text-xs font-medium transition-colors"
                        >
                          设为当前播放
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Waiting Section */}
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <Video className="w-4 h-4 text-orange-500" />
                等待视频生成
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={addWaitingItem}
                  className="px-3 py-1.5 bg-orange-50 hover:bg-orange-100 text-orange-600 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <Upload className="w-3 h-3" />
                  新增等待视频
                </button>
              </div>
            </div>

            <div className="flex overflow-x-auto gap-4 pb-2 snap-x">
              {waitingList.map((item, idx) => (
                <div key={item.id} className="min-w-[280px] w-[280px] flex-shrink-0 bg-slate-50 border border-slate-200 rounded-lg p-4 snap-center flex flex-col gap-3 relative">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500">等待视频 {idx + 1}</span>
                    <div className="flex items-center gap-2">
                      {waitingVideo === item.videoUrl && item.videoUrl && (
                        <span className="text-[10px] bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-bold">
                          当前使用
                        </span>
                      )}
                          <label className="cursor-pointer p-1 hover:bg-orange-100 rounded-md transition-colors text-orange-500" title="上传视频">
                        <Upload className="w-3.5 h-3.5" />
                        <input
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files[0];
                            if (file) {
                              const url = URL.createObjectURL(file);
                              // 当用户手动上传等待视频时，同样进行拆分处理
                              try {
                                const splits = await splitWaitingVideo(url, (msg) => console.log('[FFmpeg Split Uploaded]', msg));
                                const waitingData = {
                                  original: url,
                                  first2s: URL.createObjectURL(splits.first2s),
                                  rest: URL.createObjectURL(splits.rest),
                                  first2sRev: URL.createObjectURL(splits.first2sRev)
                                };
                                updateWaitingItem(item.id, { videoUrl: waitingData });
                                if (!activeNode.waitingVideo) selectWaitingVideo(waitingData);
                              } catch (err) {
                                console.error('Failed to split uploaded waiting video:', err);
                                updateWaitingItem(item.id, { videoUrl: url });
                                if (!activeNode.waitingVideo) selectWaitingVideo(url);
                              }
                            }
                            if (e.target) e.target.value = null;
                          }}
                        />
                      </label>
                      {waitingList.length > 1 && (
                        <button
                          onClick={() => removeWaitingItem(item.id)}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-medium text-slate-500 mb-2">生成方式</label>
                    <select
                      value={typeof item.method === 'number' ? item.method : 1}
                      onChange={(e) => updateWaitingItem(item.id, { method: parseInt(e.target.value) })}
                      className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all mb-3 bg-white"
                    >
                      <option value={1}>Type 1: 节点帧生成 (DoubaoSeedance)</option>
                      <option value={2}>Type 2: 节点帧-参考帧 (5s)</option>
                      <option value={3}>Type 3: 过渡(加速) + 等待态</option>
                      <option value={4}>Type 4: 参考帧生成 (5s)</option>
                      <option value={5}>Type 5: 节点帧-参考帧 (10s)</option>
                      <option value={6}>Type 6: 参考帧-参考帧 (10s)</option>
                      <option value={7}>Type 7: 过渡 + 循环等待 + 反向过渡</option>
                      <option value={8}>Type 8: 节点帧 (HappyHorse)</option>
                      <option value={9}>Type 9: 参考帧 (HappyHorse)</option>
                    </select>

                    {/* Prompt (所有 type 通用) */}
                    <label className="block text-[10px] font-medium text-slate-500 mb-1">生成提示词 (Prompt)</label>
                    <textarea
                      value={item.prompt || DEFAULT_WAITING_PROMPT}
                      onChange={(e) => updateWaitingItem(item.id, { prompt: e.target.value })}
                      placeholder="输入画面生成提示词..."
                      className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all resize-none mb-3"
                      rows={2}
                    />

                    {/* Type 2/4/5/6: duration */}
                    {[2, 4, 5, 6].includes(item.method) && (
                      <div className="flex items-center gap-2 mb-3">
                        <label className="text-[10px] font-medium text-slate-500">时长</label>
                        <input
                          type="number" min="1" max="10" step="0.5"
                          value={item.duration ?? (item.method >= 5 ? 10.0 : 5.0)}
                          onChange={(e) => updateWaitingItem(item.id, { duration: parseFloat(e.target.value) })}
                          className="w-16 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none"
                        />
                        <span className="text-[10px] text-slate-400">秒</span>
                      </div>
                    )}

                    {/* Type 3: 双阶段参数 */}
                    {item.method === 3 && (
                      <div className="bg-orange-50/50 p-2 rounded-lg border border-orange-100 mb-3">
                        <div className="mb-2">
                          <div className="flex justify-between items-center mb-1">
                            <label className="text-[10px] font-medium text-slate-500">阶段 1: 节点帧 -{'>'} 参考帧 (过渡)</label>
                            <div className="flex items-center gap-1">
                              <input
                                type="number" min="1" max="10" step="0.5"
                                value={item.duration1 || 4.0}
                                onChange={(e) => updateWaitingItem(item.id, { duration1: parseFloat(e.target.value) })}
                                className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none"
                              />
                              <span className="text-[10px] text-slate-400">秒</span>
                            </div>
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <label className="text-[10px] font-medium text-slate-500">阶段 2: 参考帧 -{'>'} 参考帧 (循环)</label>
                            <div className="flex items-center gap-1">
                              <input
                                type="number" min="4" max="10" step="0.5"
                                value={item.duration2 || 5.0}
                                onChange={(e) => updateWaitingItem(item.id, { duration2: Math.max(4, parseFloat(e.target.value)) })}
                                className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none"
                              />
                              <span className="text-[10px] text-slate-400">秒</span>
                            </div>
                          </div>
                          <label className="block text-[10px] font-medium text-slate-500 mb-1">阶段 2 提示词</label>
                          <textarea
                            value={item.prompt2 || DEFAULT_WAITING_PROMPT}
                            onChange={(e) => updateWaitingItem(item.id, { prompt2: e.target.value })}
                            placeholder="输入阶段2提示词..."
                            className="w-full text-xs p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all resize-none"
                            rows={2}
                          />
                        </div>
                      </div>
                    )}

                    {/* Type 7: 循环参数 */}
                    {item.method === 7 && (
                      <div className="bg-orange-50/50 p-2 rounded-lg border border-orange-100 mb-3 flex flex-wrap gap-3">
                        <div className="flex items-center gap-1">
                          <label className="text-[10px] font-medium text-slate-500">过渡</label>
                          <input type="number" min="1" max="10" step="0.5" value={item.transition_duration || 4.0}
                            onChange={(e) => updateWaitingItem(item.id, { transition_duration: parseFloat(e.target.value) })}
                            className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none" />
                          <span className="text-[10px] text-slate-400">秒</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-[10px] font-medium text-slate-500">循环</label>
                          <input type="number" min="2" max="16" step="1" value={item.loop_duration || 8.0}
                            onChange={(e) => updateWaitingItem(item.id, { loop_duration: parseFloat(e.target.value) })}
                            className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none" />
                          <span className="text-[10px] text-slate-400">秒</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-[10px] font-medium text-slate-500">循环次数</label>
                          <input type="number" min="1" max="10" step="1" value={item.loop_count || 2}
                            onChange={(e) => updateWaitingItem(item.id, { loop_count: parseInt(e.target.value) })}
                            className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none" />
                        </div>
                      </div>
                    )}

                    {/* Type 8/9: HappyHorse 参数 */}
                    {[8, 9].includes(item.method) && (
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex items-center gap-1">
                          <label className="text-[10px] font-medium text-slate-500">时长</label>
                          <input type="number" min="1" max="10" step="1" value={item.hh_duration || 5}
                            onChange={(e) => updateWaitingItem(item.id, { hh_duration: parseInt(e.target.value) })}
                            className="w-12 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none" />
                          <span className="text-[10px] text-slate-400">秒</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-[10px] font-medium text-slate-500">分辨率</label>
                          <select value={item.hh_resolution || '720P'}
                            onChange={(e) => updateWaitingItem(item.id, { hh_resolution: e.target.value })}
                            className="text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none bg-white">
                            <option value="480P">480P</option>
                            <option value="720P">720P</option>
                            <option value="1080P">1080P</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {/* 循环起始时间（拆分点） */}
                    <div className="flex items-center gap-2 mb-3">
                      <label className="text-[10px] font-medium text-slate-500">循环起始时间</label>
                      <input
                        type="number" min="0.5" max="5" step="0.5"
                        value={item.split_time ?? 2.0}
                        onChange={(e) => updateWaitingItem(item.id, { split_time: parseFloat(e.target.value) })}
                        className="w-16 text-xs p-1 border border-slate-200 rounded focus:ring-1 focus:ring-orange-500 outline-none"
                      />
                      <span className="text-[10px] text-slate-400">秒（前N秒为进入动画，之后开始循环）</span>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleGenerateWaiting(item)}
                        disabled={generatingWaitingId === item.id}
                        className="flex-1 py-1.5 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                        title="开始生成"
                      >
                        {generatingWaitingId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                        开始生成
                      </button>
                    </div>
                  </div>

                  {item.videoUrl && (
                    <div className="mt-auto">
                      <label className="block text-[10px] font-medium text-slate-500 mb-1">视频预览 (拆分视图)</label>
                      <div className="bg-slate-900 rounded-lg overflow-hidden relative group/vid p-2 gap-2 grid grid-cols-2 grid-rows-2">
                        {typeof item.videoUrl === 'object' && item.videoUrl.original ? (
                          <>
                            {/* 原始视频 */}
                            <div className="relative aspect-video bg-black rounded border border-slate-700">
                              <video controls src={item.videoUrl.original} className="w-full h-full object-contain" />
                              <div className="absolute top-1 left-1 bg-black/60 text-white px-1.5 py-0.5 text-[8px] rounded backdrop-blur-sm">原始视频</div>
                            </div>
                            {/* 0-2s */}
                            <div className="relative aspect-video bg-black rounded border border-slate-700">
                              <video controls src={item.videoUrl.first2s} className="w-full h-full object-contain" />
                              <div className="absolute top-1 left-1 bg-black/60 text-white px-1.5 py-0.5 text-[8px] rounded backdrop-blur-sm">前 2s</div>
                            </div>
                            {/* 剩余后半段 */}
                            <div className="relative aspect-video bg-black rounded border border-slate-700">
                              <video controls src={item.videoUrl.rest} className="w-full h-full object-contain" />
                              <div className="absolute top-1 left-1 bg-black/60 text-white px-1.5 py-0.5 text-[8px] rounded backdrop-blur-sm">后半段</div>
                            </div>
                            {/* 前2s 倒放 */}
                            <div className="relative aspect-video bg-black rounded border border-slate-700">
                              <video controls src={item.videoUrl.first2sRev} className="w-full h-full object-contain" />
                              <div className="absolute top-1 left-1 bg-black/60 text-white px-1.5 py-0.5 text-[8px] rounded backdrop-blur-sm">前 2s (倒放)</div>
                            </div>
                          </>
                        ) : typeof item.videoUrl === 'object' && item.videoUrl.forward ? (
                          <div className="col-span-2 row-span-2 w-full h-full flex divide-x divide-slate-700 bg-slate-900 relative">
                            <div className="flex-1 relative flex items-center justify-center bg-black">
                              <video controls src={item.videoUrl.forward} className="w-full h-full object-contain" />
                              <div className="absolute top-2 left-2 bg-black/60 text-white px-2 py-1 text-[10px] rounded backdrop-blur-sm">正放</div>
                            </div>
                            <div className="flex-1 relative flex items-center justify-center bg-black">
                              <video controls src={item.videoUrl.reverse} className="w-full h-full object-contain" />
                              <div className="absolute top-2 left-2 bg-black/60 text-white px-2 py-1 text-[10px] rounded backdrop-blur-sm">倒放</div>
                            </div>
                          </div>
                        ) : (
                          <div className="col-span-2 row-span-2 relative aspect-video bg-black rounded border border-slate-700">
                            <video controls src={item.videoUrl} className="w-full h-full object-contain" />
                          </div>
                        )}
                        <button
                          onClick={() => updateWaitingItem(item.id, { videoUrl: null })}
                          className="absolute top-1 right-1 p-1 bg-red-500/80 hover:bg-red-600 text-white rounded-md opacity-0 group-hover/vid:opacity-100 transition-opacity z-10"
                          title="清除视频"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {waitingVideo !== item.videoUrl && (
                        <button
                          onClick={() => selectWaitingVideo(item.videoUrl)}
                          className="w-full mt-2 py-1.5 bg-white border border-orange-200 text-orange-600 hover:bg-orange-50 rounded-lg text-xs font-medium transition-colors"
                        >
                          设为当前播放
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          
          {/* Batch Generation Section */}
          {/* <div className="bg-emerald-50/50 p-5 rounded-xl shadow-sm border border-emerald-200 mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-emerald-800 flex items-center gap-2">
                <Video className="w-4 h-4 text-emerald-600" />
                一键生成所有组合
              </h3>
            </div>
            <p className="text-xs text-emerald-700 mb-4">
              将遍历所有的引导语音频和反馈语音频，进行两两组合，生成对应的等待、引导、反馈视频。
            </p>
            <button
              onClick={handleBatchGenerateMerge}
              disabled={isBatchGenerating}
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isBatchGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {isBatchGenerating ? batchProgress : '开始一键生成'}
            </button>
          </div> */}

          {/* Merged Results Section */}
          {/* {activeNode.mergedResults && activeNode.mergedResults.length > 0 && (
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 mt-6">
              <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2 mb-4">
                <Video className="w-4 h-4 text-indigo-500" />
                组合生成结果
              </h3>
              <div className="flex flex-col gap-4">
                {activeNode.mergedResults.map((combo) => {
                  const isCurrentCombo = 
                    activeNode.waitingVideo === combo.waitingVideo &&
                    activeNode.guidanceVideo === combo.guidanceVideo &&
                    activeNode.feedbackVideo === combo.feedbackVideo;

                  return (
                    <div key={combo.id} className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col gap-3 relative">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-bold text-slate-700">{combo.title}</span>
                          {isCurrentCombo && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full font-bold">
                              当前使用
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {!isCurrentCombo && (
                            <button
                              onClick={() => {
                                updateNode(activeNodeId, {
                                  waitingVideo: combo.waitingVideo,
                                  guidanceVideo: combo.guidanceVideo,
                                  feedbackVideo: combo.feedbackVideo
                                });
                              }}
                              className="px-2 py-1 bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-50 rounded-md text-xs font-medium transition-colors"
                            >
                              设为当前播放组合
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const newResults = activeNode.mergedResults.filter(r => r.id !== combo.id);
                              updateNode(activeNodeId, { mergedResults: newResults });
                            }}
                            className="text-slate-400 hover:text-red-500 transition-colors p-1"
                            title="删除该组合"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <span className="text-xs font-medium text-slate-500 mb-1 block">等待视频</span>
                          <div className="aspect-video bg-black rounded-lg overflow-hidden">
                            {combo.waitingVideo ? <video controls src={combo.waitingVideo} className="w-full h-full object-contain" /> : <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">无</div>}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs font-medium text-slate-500 mb-1 block">引导语视频</span>
                          <div className="aspect-video bg-black rounded-lg overflow-hidden">
                            {combo.guidanceVideo ? <video controls src={combo.guidanceVideo} className="w-full h-full object-contain" /> : <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">无</div>}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs font-medium text-slate-500 mb-1 block">反馈语视频</span>
                          <div className="aspect-video bg-black rounded-lg overflow-hidden">
                            {combo.feedbackVideo ? <video controls src={combo.feedbackVideo} className="w-full h-full object-contain" /> : <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">无</div>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )} */}
        </>
      )}

      {/* Batch Import Feedback Modal */}
      {isBatchImportFeedbackOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">批量导入反馈语</h3>
              <button 
                onClick={() => setIsBatchImportFeedbackOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-y-auto">
              <p className="text-xs text-slate-500 mb-2">
                请输入反馈语文本，每行将被解析为一个独立的反馈语卡片，并自动触发语音克隆：
              </p>
              <textarea
                value={batchImportFeedbackText}
                onChange={(e) => setBatchImportFeedbackText(e.target.value)}
                placeholder="非常棒，你做对了！&#10;再接再厉哦！&#10;注意观察一下细节。"
                className="w-full h-48 text-sm p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all resize-none"
              />
            </div>
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setIsBatchImportFeedbackOpen(false)}
                className="px-4 py-2 bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleBatchImportFeedback}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors"
              >
                开始导入并克隆
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ControlPanel;
