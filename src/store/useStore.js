import { create } from 'zustand';

const useStore = create((set) => ({
  // ── 共享视频源（所有节点共用同一主视频） ──
  videoSrc: null,
  setVideoSrc: (src) => set({ videoSrc: src }),

  // ── 全局裁剪区域（所有节点共用同一裁剪框，只设置一次） ──
  globalCropArea: null,         // { x, y, width, height }
  globalVideoNaturalSize: null, // { width, height }
  globalReferenceFrame: null,   // 全局唯一参考帧 (Blob)
  globalReferenceFrameTime: null, // 全局参考帧的时间点 (Number)
  setGlobalCropArea: (cropArea, videoNaturalSize, referenceFrameBlob = null, referenceFrameTime = null) =>
    set((state) => ({ 
      globalCropArea: cropArea, 
      globalVideoNaturalSize: videoNaturalSize,
      globalReferenceFrame: referenceFrameBlob || state.globalReferenceFrame,
      globalReferenceFrameTime: referenceFrameTime !== null ? referenceFrameTime : state.globalReferenceFrameTime
    })),

  // ── 工作区模式（edit = 编辑/处理, preview = 交互预览, waiting = 等待态循环模拟） ──
  workspaceMode: 'edit',
  setWorkspaceMode: (mode) => set({ workspaceMode: mode }),

  // ── 全局视频播放控制（由 VideoPlayer 注册，供任意层调用） ──
  isVideoPlaying: false,
  setIsVideoPlaying: (val) => set({ isVideoPlaying: val }),
  _videoTogglePlay: null,          // VideoPlayer 挂载时注入
  registerVideoToggle: (fn) => set({ _videoTogglePlay: fn }),
  unregisterVideoToggle: () => set({ _videoTogglePlay: null }),

  // ── 交互节点列表 ──
  // 每个节点结构：{ id, interactionTime, cropArea, videoNaturalSize, croppedImage, guidanceVideo, feedbackVideo, waitingVideo, guidanceText, feedbackText }
  nodes: [],

  // 当前在控制面板中选中的节点 ID（用于生成视频）
  activeNodeId: null,

  addNode: (nodeData) => {
    const id = Date.now().toString();
    let activeId = id;
    set((state) => {
      const nodeCount = state.nodes.length + 1;
      const node = {
        id,
        label: `节点${nodeCount}`,
        interactionTime: nodeData.interactionTime,
        cropArea: nodeData.cropArea,
        videoNaturalSize: nodeData.videoNaturalSize,
        croppedImage: nodeData.croppedImage ?? null,
        guidanceVideo: null,
        feedbackVideo: null,
        waitingVideo: null,
        waitingList: [{ id: Date.now().toString() + '-w1', videoUrl: null }],
        guidanceList: [{ id: Date.now().toString() + '-g1', text: '', audio: null, videoUrl: null }],
        feedbackList: [{ id: Date.now().toString() + '-f1', text: '', audio: null, videoUrl: null }],
      };
      return { nodes: [...state.nodes, node], activeNodeId: id };
    });
    return activeId;
  },

  updateNode: (id, updates) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),

  removeNode: (id) =>
    set((state) => {
      const remaining = state.nodes.filter((n) => n.id !== id);
      const newActiveId =
        state.activeNodeId === id ? (remaining[0]?.id ?? null) : state.activeNodeId;
      return { nodes: remaining, activeNodeId: newActiveId };
    }),

  setActiveNodeId: (id) => set({ activeNodeId: id }),

  // ── Demo 模式 ──
  demoMode: false,
  setDemoMode: (val) => set({ demoMode: val }),

  // ── 视频跳转控制 ──
  seekRequest: null, // { time: number, timestamp: number }
  requestSeek: (time) => set({ seekRequest: { time, timestamp: Date.now() } }),

  /**
   * 一次性加载 Demo 所需的所有状态
   *
   * 支持两种格式：
   *   单节点（旧格式）：{ mainVideoUrl, interactionData, croppedImage, waitingVideoUrl, guidanceVideoUrl, feedbackVideoUrl }
   *   多节点（新格式）：{ mainVideoUrl, nodes: [{ interactionTime, cropArea, videoNaturalSize, croppedImage, waitingVideoUrl, guidanceVideoUrl, feedbackVideoUrl }] }
   */
  loadDemoData: (demo) => {
    const now = Date.now();
    let builtNodes;

    if (Array.isArray(demo.nodes)) {
      // 多节点格式
      builtNodes = demo.nodes.map((n, i) => ({
        id: (now + i).toString(),
        interactionTime: n.interactionTime ?? 0,
        cropArea: n.cropArea ?? null,
        videoNaturalSize: n.videoNaturalSize ?? null,
        croppedImage: n.croppedImage ?? null,
        guidanceVideo: n.guidanceVideos?.[0]?.url ?? n.guidanceVideoUrl ?? null,
        feedbackVideo: n.feedbackVideos?.[0]?.url ?? n.feedbackVideoUrl ?? null,
        waitingVideo: n.waitingVideos?.[0]?.url ?? n.waitingVideoUrl ?? null,
        waitingList: n.waitingVideos?.length 
          ? n.waitingVideos.map((w, idx) => ({ id: `demo-w${idx+1}`, videoUrl: w.url }))
          : n.waitingVideoUrl 
            ? [{ id: 'demo-w1', videoUrl: n.waitingVideoUrl }]
            : [{ id: 'demo-w1', videoUrl: null }],
        guidanceList: n.guidanceVideos?.length 
          ? n.guidanceVideos.map((g, idx) => ({ id: `demo-g${idx+1}`, text: g.text || '', audio: null, videoUrl: g.url }))
          : n.guidanceVideoUrl 
            ? [{ id: 'demo-g1', text: n.guidanceText ?? '', audio: null, videoUrl: n.guidanceVideoUrl }]
            : [{ id: 'demo-g1', text: n.guidanceText ?? '', audio: null, videoUrl: null }],
        feedbackList: n.feedbackVideos?.length 
          ? n.feedbackVideos.map((f, idx) => ({ id: `demo-f${idx+1}`, text: f.text || '', audio: null, videoUrl: f.url }))
          : n.feedbackVideoUrl 
            ? [{ id: 'demo-f1', text: n.feedbackText ?? '', audio: null, videoUrl: n.feedbackVideoUrl }]
            : [{ id: 'demo-f1', text: n.feedbackText ?? '', audio: null, videoUrl: null }],
      }));
    } else {
      // 单节点（旧格式）兼容
      builtNodes = [{
        id: now.toString(),
        interactionTime: demo.interactionData?.interactionTime ?? 0,
        cropArea: demo.interactionData?.cropArea ?? null,
        videoNaturalSize: demo.interactionData?.videoNaturalSize ?? null,
        croppedImage: demo.croppedImage ?? null,
        guidanceVideo: demo.guidanceVideoUrl ?? null,
        feedbackVideo: demo.feedbackVideoUrl ?? null,
        waitingVideo: demo.waitingVideoUrl ?? null,
        waitingList: demo.waitingVideoUrl 
          ? [{ id: 'demo-w1', videoUrl: demo.waitingVideoUrl }]
          : [{ id: 'demo-w1', videoUrl: null }],
        guidanceList: demo.guidanceVideoUrl 
          ? [{ id: 'demo-g1', text: demo.guidanceText ?? '', audio: null, videoUrl: demo.guidanceVideoUrl }]
          : [{ id: 'demo-g1', text: demo.guidanceText ?? '', audio: null, videoUrl: null }],
        feedbackList: demo.feedbackVideoUrl 
          ? [{ id: 'demo-f1', text: demo.feedbackText ?? '', audio: null, videoUrl: demo.feedbackVideoUrl }]
          : [{ id: 'demo-f1', text: demo.feedbackText ?? '', audio: null, videoUrl: null }],
      }];
    }

    set({
      demoMode: true,
      videoSrc: demo.mainVideoUrl ?? demo.interactionData?.videoSrc ?? null,
      nodes: builtNodes,
      activeNodeId: builtNodes[0]?.id ?? null,
    });
  },

  /** 清空所有 demo 数据，回到正常流程 */
  clearDemoData: () =>
    set({
      demoMode: false,
      videoSrc: null,
      nodes: [],
      activeNodeId: null,
    }),

  /** 从 ZIP 导入整个项目数据 */
  loadProjectState: (projectState) => {
    set({
      demoMode: false,
      videoSrc: projectState.videoSrc,
      globalCropArea: projectState.globalCropArea,
      globalVideoNaturalSize: projectState.globalVideoNaturalSize,
      globalReferenceFrame: projectState.globalReferenceFrame || null,
      globalReferenceFrameTime: projectState.globalReferenceFrameTime ?? null,
      nodes: projectState.nodes,
      activeNodeId: projectState.nodes[0]?.id ?? null,
    });
  },
}));

export default useStore;
