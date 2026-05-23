import JSZip from 'jszip';

export async function exportProjectToZip({
  videoSrc,
  nodes,
  globalCropArea,
  globalVideoNaturalSize,
  globalReferenceFrame,
  globalReferenceFrameTime,
  onProgress,
}) {
  const zip = new JSZip();
  const assets = zip.folder("assets");

  let assetCounter = 0;
  const urlToPathMap = new Map();

  // 截取文本作为文件名前缀的辅助函数
  const sanitizeText = (text) => {
    if (!text) return '';
    // 移除特殊字符，只保留中英文数字，限制长度最多 10 个字符
    return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 10);
  };

  async function addAsset(url, extension, hint = '') {
    if (!url) return null;
    if (urlToPathMap.has(url)) return urlToPathMap.get(url);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const prefix = hint ? `${sanitizeText(hint)}_` : '';
      const filename = `${prefix}asset_${assetCounter++}.${extension}`;
      assets.file(filename, blob);
      const path = `assets/${filename}`;
      urlToPathMap.set(url, path);
      return path;
    } catch (e) {
      console.error("Failed to fetch asset", url, e);
      return null;
    }
  }

  async function addFile(file, extension, hint = '') {
    if (!file) return null;
    const prefix = hint ? `${sanitizeText(hint)}_` : '';
    const filename = `${prefix}asset_${assetCounter++}_${file.name || 'file.' + extension}`;
    assets.file(filename, file);
    return `assets/${filename}`;
  }

  async function addBlob(blob, extension, hint = '') {
    if (!blob) return null;
    const prefix = hint ? `${sanitizeText(hint)}_` : '';
    const filename = `${prefix}asset_${assetCounter++}.${extension}`;
    assets.file(filename, blob);
    return `assets/${filename}`;
  }

  // 写入纯文本内容为单独的文件，允许自定义后缀名
  async function addTextFile(textContent, hint = '', fileExtension = 'txt') {
    if (!textContent) return null;
    const prefix = hint ? `${hint}_` : '';
    const filename = `${prefix}文本_${assetCounter++}.${fileExtension}`;
    assets.file(filename, textContent);
    return `assets/${filename}`;
  }

  onProgress?.('正在打包视频和音频资源...');

  const config = {
    version: 3,
    // 导出时不包含原始视频，减小包体积
    videoSrc: null,
    globalCropArea,
    globalVideoNaturalSize,
    globalReferenceFrameTime,
    globalReferenceFrame: await addBlob(globalReferenceFrame, 'png', '全局参考帧'),
    nodes: await Promise.all(nodes.map(async (node, nodeIndex) => {
      const nPrefix = node.label || `节点${nodeIndex + 1}`;

      // 提取节点的 Meta 数据（如时间节点、裁剪区域等）
      const nodeMetaData = {
        nodeId: node.id,
        interactionTime: node.interactionTime,
        cropArea: node.cropArea || globalCropArea,
        videoNaturalSize: node.videoNaturalSize || globalVideoNaturalSize,
        label: node.label || `交互节点 ${nodeIndex + 1}`
      };
      // 将该节点的元数据保存为一个单独的 JSON 文件
      const metaContentFile = await addTextFile(JSON.stringify(nodeMetaData, null, 2), `${nPrefix}_配置数据`, 'json');

      // 直接打包原文件，不进行视频合成
      const processVideoUrl = async (url) => url;

      return {
        ...node,
        metaContentFile,
        croppedImage: await addBlob(node.croppedImage, 'png', `${nPrefix}_参考帧`),
        waitingVideo: node.waitingVideo && typeof node.waitingVideo === 'object' && node.waitingVideo.original 
          ? {
              original: await addAsset(await processVideoUrl(node.waitingVideo.original), 'mp4', `${nPrefix}_等待态_原版`),
              first2s: await addAsset(await processVideoUrl(node.waitingVideo.first2s), 'mp4', `${nPrefix}_等待态_前2秒`),
              rest: await addAsset(await processVideoUrl(node.waitingVideo.rest), 'mp4', `${nPrefix}_等待态_剩余`),
              first2sRev: await addAsset(await processVideoUrl(node.waitingVideo.first2sRev), 'mp4', `${nPrefix}_等待态_前2秒反转`),
            }
          : await addAsset(await processVideoUrl(node.waitingVideo), 'mp4', `${nPrefix}_等待态`),
        guidanceVideo: await addAsset(await processVideoUrl(node.guidanceVideo), 'mp4', `${nPrefix}_引导语`),
        feedbackVideo: await addAsset(await processVideoUrl(node.feedbackVideo), 'mp4', `${nPrefix}_反馈语`),
        guidanceList: await Promise.all((node.guidanceList || []).map(async (g, i) => ({
          ...g,
          textContentFile: g.text ? await addTextFile(g.text, `${nPrefix}_引导语_文本_${i+1}`) : null,
          audio: g.audio ? {
            name: g.audio.name,
            file: await addFile(g.audio.file, 'wav', `${nPrefix}_引导语_音频_${i+1}`)
          } : null,
          videoUrl: await addAsset(await processVideoUrl(g.videoUrl), 'mp4', `${nPrefix}_引导语_视频_${i+1}`)
        }))),
        feedbackList: await Promise.all((node.feedbackList || []).map(async (f, i) => ({
          ...f,
          textContentFile: f.text ? await addTextFile(f.text, `${nPrefix}_反馈语_文本_${i+1}`) : null,
          audio: f.audio ? {
            name: f.audio.name,
            file: await addFile(f.audio.file, 'wav', `${nPrefix}_反馈语_音频_${i+1}`)
          } : null,
          videoUrl: await addAsset(await processVideoUrl(f.videoUrl), 'mp4', `${nPrefix}_反馈语_视频_${i+1}`)
        }))),
        waitingList: await Promise.all((node.waitingList || []).map(async (w, i) => ({
          ...w,
          videoUrl: w.videoUrl && typeof w.videoUrl === 'object' && w.videoUrl.original
            ? {
                original: await addAsset(await processVideoUrl(w.videoUrl.original), 'mp4', `${nPrefix}_等待态_视频_原版_${i+1}`),
                first2s: await addAsset(await processVideoUrl(w.videoUrl.first2s), 'mp4', `${nPrefix}_等待态_视频_前2秒_${i+1}`),
                rest: await addAsset(await processVideoUrl(w.videoUrl.rest), 'mp4', `${nPrefix}_等待态_视频_剩余_${i+1}`),
                first2sRev: await addAsset(await processVideoUrl(w.videoUrl.first2sRev), 'mp4', `${nPrefix}_等待态_视频_前2秒反转_${i+1}`)
              }
            : await addAsset(await processVideoUrl(w.videoUrl), 'mp4', `${nPrefix}_等待态_视频_${i+1}`)
        }))),
        mergedResults: await Promise.all((node.mergedResults || []).map(async (m, i) => ({
          ...m,
          waitingVideo: m.waitingVideo && typeof m.waitingVideo === 'object' && m.waitingVideo.original
            ? {
                original: await addAsset(await processVideoUrl(m.waitingVideo.original), 'mp4', `${nPrefix}_合成_等待态_原版_${i+1}`),
                first2s: await addAsset(await processVideoUrl(m.waitingVideo.first2s), 'mp4', `${nPrefix}_合成_等待态_前2秒_${i+1}`),
                rest: await addAsset(await processVideoUrl(m.waitingVideo.rest), 'mp4', `${nPrefix}_合成_等待态_剩余_${i+1}`),
                first2sRev: await addAsset(await processVideoUrl(m.waitingVideo.first2sRev), 'mp4', `${nPrefix}_合成_等待态_前2秒反转_${i+1}`)
              }
            : await addAsset(await processVideoUrl(m.waitingVideo), 'mp4', `${nPrefix}_合成_等待态_${i+1}`),
          guidanceVideo: await addAsset(await processVideoUrl(m.guidanceVideo), 'mp4', `${nPrefix}_合成_引导语_${i+1}`),
          feedbackVideo: await addAsset(await processVideoUrl(m.feedbackVideo), 'mp4', `${nPrefix}_合成_反馈语_${i+1}`)
        })))
      };
    }))
  };

  onProgress?.('正在生成 ZIP 文件...');
  zip.file("config.json", JSON.stringify(config, null, 2));

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return zipBlob;
}

export async function importProjectFromZip(zipFile, onProgress) {
  onProgress?.('正在读取 ZIP 文件...');
  const zip = await JSZip.loadAsync(zipFile);
  
  const configStr = await zip.file("config.json").async("string");
  const config = JSON.parse(configStr);

  const pathToUrlMap = new Map();
  
  async function restoreAsset(path, type) {
    if (!path) return null;
    if (pathToUrlMap.has(path)) return pathToUrlMap.get(path);
    const fileObj = zip.file(path);
    if (!fileObj) return null;
    const fileData = await fileObj.async("arraybuffer");
    const blob = new Blob([fileData], { type });
    const url = URL.createObjectURL(blob);
    pathToUrlMap.set(path, url);
    return url;
  }
  
  async function restoreFile(path, type, name) {
    if (!path) return null;
    const fileObj = zip.file(path);
    if (!fileObj) return null;
    const fileData = await fileObj.async("arraybuffer");
    const file = new File([fileData], name, { type });
    return file;
  }
  
  async function restoreBlob(path, type) {
    if (!path) return null;
    const fileObj = zip.file(path);
    if (!fileObj) return null;
    const fileData = await fileObj.async("arraybuffer");
    return new Blob([fileData], { type });
  }

  onProgress?.('正在恢复资源...');

  const videoSrc = await restoreAsset(config.videoSrc, 'video/mp4');

  const nodes = await Promise.all(config.nodes.map(async (node) => {
    return {
      ...node,
      croppedImage: await restoreBlob(node.croppedImage, 'image/png'),
      waitingVideo: node.waitingVideo && typeof node.waitingVideo === 'object' && node.waitingVideo.original
        ? {
            original: await restoreAsset(node.waitingVideo.original, 'video/mp4'),
            first2s: await restoreAsset(node.waitingVideo.first2s, 'video/mp4'),
            rest: await restoreAsset(node.waitingVideo.rest, 'video/mp4'),
            first2sRev: await restoreAsset(node.waitingVideo.first2sRev, 'video/mp4')
          }
        : await restoreAsset(node.waitingVideo, 'video/mp4'),
      guidanceVideo: await restoreAsset(node.guidanceVideo, 'video/mp4'),
      feedbackVideo: await restoreAsset(node.feedbackVideo, 'video/mp4'),
      guidanceList: await Promise.all((node.guidanceList || []).map(async g => {
        let audio = null;
        if (g.audio) {
          const file = await restoreFile(g.audio.file, 'audio/wav', g.audio.name);
          audio = {
            name: g.audio.name,
            file: file,
            url: URL.createObjectURL(file)
          };
        }
        return {
          ...g,
          audio,
          videoUrl: await restoreAsset(g.videoUrl, 'video/mp4')
        };
      })),
      feedbackList: await Promise.all((node.feedbackList || []).map(async f => {
        let audio = null;
        if (f.audio) {
          const file = await restoreFile(f.audio.file, 'audio/wav', f.audio.name);
          audio = {
            name: f.audio.name,
            file: file,
            url: URL.createObjectURL(file)
          };
        }
        return {
          ...f,
          audio,
          videoUrl: await restoreAsset(f.videoUrl, 'video/mp4')
        };
      })),
      waitingList: await Promise.all((node.waitingList || []).map(async w => ({
        ...w,
        videoUrl: w.videoUrl && typeof w.videoUrl === 'object' && w.videoUrl.original
          ? {
              original: await restoreAsset(w.videoUrl.original, 'video/mp4'),
              first2s: await restoreAsset(w.videoUrl.first2s, 'video/mp4'),
              rest: await restoreAsset(w.videoUrl.rest, 'video/mp4'),
              first2sRev: await restoreAsset(w.videoUrl.first2sRev, 'video/mp4')
            }
          : await restoreAsset(w.videoUrl, 'video/mp4')
      }))),
      mergedResults: await Promise.all((node.mergedResults || []).map(async m => ({
        ...m,
        waitingVideo: m.waitingVideo && typeof m.waitingVideo === 'object' && m.waitingVideo.original
          ? {
              original: await restoreAsset(m.waitingVideo.original, 'video/mp4'),
              first2s: await restoreAsset(m.waitingVideo.first2s, 'video/mp4'),
              rest: await restoreAsset(m.waitingVideo.rest, 'video/mp4'),
              first2sRev: await restoreAsset(m.waitingVideo.first2sRev, 'video/mp4')
            }
          : await restoreAsset(m.waitingVideo, 'video/mp4'),
        guidanceVideo: await restoreAsset(m.guidanceVideo, 'video/mp4'),
        feedbackVideo: await restoreAsset(m.feedbackVideo, 'video/mp4')
      })))
    };
  }));

  return {
    videoSrc,
    globalCropArea: config.globalCropArea,
    globalVideoNaturalSize: config.globalVideoNaturalSize,
    globalReferenceFrameTime: config.globalReferenceFrameTime,
    globalReferenceFrame: await restoreBlob(config.globalReferenceFrame, 'image/png'),
    nodes
  };
}