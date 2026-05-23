// 统一管理所有 API 接口地址
// 可以在这里配置不同环境下的请求域名和接口路径

const API_CONFIG = {
  // Python 后端服务（导出等）
  BACKEND_BASE_URL: 'http://localhost:13000',
  
  // 模型生成服务
  MODEL_SERVICE_URL: 'http://localhost:13000',

  // 语音克隆服务 (TTS)
  TTS_SERVICE_URL: 'http://localhost:13000',

  // Sync Video 服务
  SYNC_VIDEO_SERVICE_URL: 'http://10.195.0.3:11000',

  // Merge Gen 服务
  MERGE_GEN_SERVICE_URL: 'http://10.195.0.3:30330',

  // 具体的接口路径
  endpoints: {
    exportNodeClip: '/api/export_node_clip',
    generateVideo: '/generate',
    generateBoomerang: '/generate_boomerang',
    ttsClone: '/api/audio/clone',
    syncVideo: '/sync_video',
    mergeGen: '/merge_gen',
    lipSync: '/api/lip_sync',
    exportComposite: '/api/export/composite',
    referenceFrameGen: '/api/reference-frame-gen',
    waitingGen: '/api/waiting-gen'
  }
};

// 获取首尾帧生成参考视频接口 URL
export const getReferenceFrameGenUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.referenceFrameGen}`;
};

// 获取全画幅合成导出接口 URL
export const getExportCompositeUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.exportComposite}`;
};

// 获取完整的导出切片接口 URL
export const getExportNodeClipUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.exportNodeClip}`;
};

// 获取口型同步视频接口 URL
export const getLipSyncUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.lipSync}`;
};

// 获取语音克隆接口 URL
export const getTtsCloneUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.ttsClone}`;
};

// 获取视频生成接口 URL
export const getGenerateVideoUrl = (endpoint = API_CONFIG.endpoints.generateVideo) => {
  return `${API_CONFIG.MODEL_SERVICE_URL}${endpoint}`;
};

// 获取 sync_video 接口 URL
export const getSyncVideoUrl = () => {
  return `${API_CONFIG.SYNC_VIDEO_SERVICE_URL}${API_CONFIG.endpoints.syncVideo}`;
};

// 获取 merge_gen 接口 URL
export const getMergeGenUrl = () => {
  return `${API_CONFIG.MERGE_GEN_SERVICE_URL}${API_CONFIG.endpoints.mergeGen}`;
};

// 获取统一等待态生成接口 URL
export const getWaitingGenUrl = () => {
  return `${API_CONFIG.BACKEND_BASE_URL}${API_CONFIG.endpoints.waitingGen}`;
};

export default API_CONFIG;
