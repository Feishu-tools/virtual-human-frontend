import React, { useState, useRef } from 'react';
import {
  FolderOpen,
  Video,
  Upload,
  ChevronDown,
  ChevronUp,
  Trash2,
  Zap,
  CheckCircle,
  AlertCircle,
  Plus,
} from 'lucide-react';
import useStore from '../store/useStore';

/**
 * DemoLoader 组件（支持单节点和多节点 JSON 配置）
 *
 * JSON 格式 v1（单节点，旧格式）：
 * {
 *   "interactionTime": 5.2,
 *   "cropArea": { "x": 100, "y": 80, "width": 320, "height": 320 },
 *   "videoNaturalSize": { "width": 1280, "height": 720 },
 *   "croppedImageBase64": "data:image/png;base64,..."
 * }
 *
 * JSON 格式 v2（多节点）：
 * {
 *   "version": 2,
 *   "nodes": [
 *     { "interactionTime": 5.2, "cropArea": {...}, "videoNaturalSize": {...}, "croppedImageBase64": "..." },
 *     { "interactionTime": 12.8, ... }
 *   ]
 * }
 */
const DemoLoader = () => {
  const loadDemoData  = useStore((state) => state.loadDemoData);
  const clearDemoData = useStore((state) => state.clearDemoData);
  const demoMode      = useStore((state) => state.demoMode);

  const [expanded, setExpanded] = useState(false);

  // ── JSON 配置（解析后统一为节点数组） ──
  const [parsedNodes, setParsedNodes] = useState(null); // [{ interactionTime, cropArea, videoNaturalSize, croppedImageBase64? }]
  const [jsonFileName, setJsonFileName] = useState('');
  const jsonInputRef = useRef(null);

  // ── 主视频 ──
  const [mainVideoUrl,  setMainVideoUrl]  = useState(null);
  const [mainVideoName, setMainVideoName] = useState('');
  const mainVideoRef = useRef(null);

  // ── 每个节点的视频文件（以节点索引为 key） ──
  // nodeVideos[i] = { waitingUrl, waitingName, guidanceUrl, guidanceName, feedbackUrl, feedbackName }
  const [nodeVideos, setNodeVideos] = useState([]);

  // 每个节点的文件 input refs（动态创建）
  const nodeVideoRefs = useRef([]); // [[waitRef, guidRef, fbRef], ...]

  const [applyStatus,  setApplyStatus]  = useState(null);
  const [applyMessage, setApplyMessage] = useState('');

  // ─────────────────────── 工具：URL 清理 ───────────────────────
  const revokeUrl = (url) => { if (url) URL.revokeObjectURL(url); };

  // ─────────────────────── JSON 导入 ───────────────────────
  const handleJsonImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJsonFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);

        let nodes;
        if (Array.isArray(parsed.nodes) && parsed.version === 2) {
          // v2 多节点格式
          const valid = parsed.nodes.every(
            (n) => typeof n.interactionTime === 'number' && n.cropArea && n.videoNaturalSize
          );
          if (!valid) {
            alert('JSON 格式错误！nodes 数组中每项必须包含 interactionTime、cropArea、videoNaturalSize。');
            return;
          }
          nodes = parsed.nodes;
        } else if (typeof parsed.interactionTime === 'number' && parsed.cropArea && parsed.videoNaturalSize) {
          // v1 单节点格式 → 包装成数组
          nodes = [parsed];
        } else {
          alert('JSON 格式无法识别！请使用导出的配置文件。');
          return;
        }

        setParsedNodes(nodes);
        // 为每个节点初始化空视频槽
        setNodeVideos(nodes.map((n) => ({
          waitingVideos: Array.from({ length: n.waitingList?.length || 1 }, (_, i) => ({ url: null, name: '' })),
          guidanceVideos: Array.from({ length: n.guidanceList?.length || 1 }, (_, i) => ({ url: null, name: '', text: n.guidanceList?.[i]?.text || '' })),
          feedbackVideos: Array.from({ length: n.feedbackList?.length || 1 }, (_, i) => ({ url: null, name: '', text: n.feedbackList?.[i]?.text || '' })),
        })));
        setApplyStatus(null);
      } catch (err) {
        alert('JSON 解析失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // ─────────────────────── 视频文件选取 ───────────────────────
  const handleMainVideoFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    revokeUrl(mainVideoUrl);
    setMainVideoUrl(URL.createObjectURL(file));
    setMainVideoName(file.name);
    e.target.value = null;
    setApplyStatus(null);
  };

  const handleNodeVideoListFile = (e, nodeIdx, listType, listIdx) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setNodeVideos((prev) => {
      const next = [...prev];
      const slot = { ...next[nodeIdx] };
      const list = [...slot[listType]];
      revokeUrl(list[listIdx].url);
      list[listIdx] = { ...list[listIdx], url, name: file.name };
      slot[listType] = list;
      next[nodeIdx] = slot;
      return next;
    });
    e.target.value = null;
    setApplyStatus(null);
  };

  const addNodeVideoListItem = (nodeIdx, listType) => {
    setNodeVideos((prev) => {
      const next = [...prev];
      const slot = { ...next[nodeIdx] };
      const list = [...slot[listType]];
      list.push({ url: null, name: '', text: '' });
      slot[listType] = list;
      next[nodeIdx] = slot;
      return next;
    });
  };

  const removeNodeVideoListItem = (nodeIdx, listType, listIdx) => {
    setNodeVideos((prev) => {
      const next = [...prev];
      const slot = { ...next[nodeIdx] };
      const list = [...slot[listType]];
      revokeUrl(list[listIdx].url);
      list.splice(listIdx, 1);
      
      // Ensure at least one item remains
      if (list.length === 0) {
        list.push({ url: null, name: '', text: '' });
      }
      
      slot[listType] = list;
      next[nodeIdx] = slot;
      return next;
    });
  };

  // ─────────────────────── 应用 Demo ───────────────────────
  const handleApply = async () => {
    if (!parsedNodes) {
      setApplyStatus('error');
      setApplyMessage('请先导入 JSON 配置文件！');
      return;
    }
    if (!mainVideoUrl) {
      setApplyStatus('error');
      setApplyMessage('请选择主视频文件！');
      return;
    }

    // 将每个节点的 croppedImageBase64 转为 Blob
    const builtNodes = await Promise.all(
      parsedNodes.map(async (node, i) => {
        let croppedImage = null;
        if (node.croppedImageBase64) {
          try {
            const res = await fetch(node.croppedImageBase64);
            croppedImage = await res.blob();
          } catch (err) {
            console.error('Failed to convert base64 image for node', i, err);
          }
        }
        const vids = nodeVideos[i] ?? {};
        return {
          interactionTime: node.interactionTime,
          cropArea: node.cropArea,
          videoNaturalSize: node.videoNaturalSize,
          croppedImage,
          waitingVideos: vids.waitingVideos ?? [],
          guidanceVideos: vids.guidanceVideos ?? [],
          feedbackVideos: vids.feedbackVideos ?? [],
        };
      })
    );

    loadDemoData({ mainVideoUrl, nodes: builtNodes });
    setApplyStatus('success');
    setApplyMessage(`Demo 已加载！共 ${builtNodes.length} 个交互节点已同步更新。`);
  };

  // ─────────────────────── 清空 Demo ───────────────────────
  const handleClear = () => {
    clearDemoData();
    revokeUrl(mainVideoUrl);
    nodeVideos.forEach((slot) => {
      slot.waitingVideos?.forEach(v => revokeUrl(v.url));
      slot.guidanceVideos?.forEach(v => revokeUrl(v.url));
      slot.feedbackVideos?.forEach(v => revokeUrl(v.url));
    });
    setMainVideoUrl(null);  setMainVideoName('');
    setParsedNodes(null);   setJsonFileName('');
    setNodeVideos([]);
    nodeVideoRefs.current = [];
    setApplyStatus(null);   setApplyMessage('');
  };

  // ─────────────────────── 渲染辅助：小型文件行 ───────────────────────
  const MiniFileRow = ({ label, fileName, onSelect, onClear, color = 'slate' }) => {
    const colors = {
      orange:  { bg: 'bg-orange-50',  border: 'border-orange-200',  text: 'text-orange-700',  dot: 'bg-orange-400'  },
      blue:    { bg: 'bg-blue-50',    border: 'border-blue-200',    text: 'text-blue-700',    dot: 'bg-blue-400'    },
      purple:  { bg: 'bg-purple-50',  border: 'border-purple-200',  text: 'text-purple-700',  dot: 'bg-purple-400'  },
      slate:   { bg: 'bg-slate-50',   border: 'border-slate-200',   text: 'text-slate-600',   dot: 'bg-slate-400'   },
    };
    const c = colors[color] ?? colors.slate;

    return (
      <div
        onClick={onSelect}
        className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-pointer transition-colors hover:opacity-80 ${
          fileName ? `${c.bg} ${c.border}` : 'bg-slate-50 border-slate-200'
        }`}
      >
        <Video className={`w-3 h-3 flex-shrink-0 ${fileName ? c.text : 'text-slate-400'}`} />
        <span className={`text-[11px] font-medium flex-1 truncate ${fileName ? c.text : 'text-slate-400'}`}>
          {fileName || label}
        </span>
        {fileName ? (
          <button
            type="button"
            onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); onClear(); }}
            className="text-slate-300 hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        ) : (
          <Upload className="w-3 h-3 text-slate-400 flex-shrink-0" />
        )}
      </div>
    );
  };

  const formatTimePrecise = (t) => {
    if (!t || isNaN(t)) return '00:00.00';
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
  };

  return (
    <div className={`rounded-xl border shadow-sm transition-all ${
      demoMode ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'
    }`}>
      {/* ── 头部折叠按钮 ── */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer select-none"
      >
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg ${demoMode ? 'bg-amber-200' : 'bg-slate-100'}`}>
            <Zap className={`w-4 h-4 ${demoMode ? 'text-amber-700' : 'text-slate-500'}`} />
          </div>
          <div>
            <p className={`text-sm font-semibold ${demoMode ? 'text-amber-800' : 'text-slate-700'}`}>
              Demo 模式
              {demoMode && (
                <span className="ml-2 text-[10px] font-normal bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full">
                  运行中
                </span>
              )}
            </p>
            <p className="text-[11px] text-slate-400">加载本地文件绕过后端 API</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {demoMode && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClear(); }}
              className="flex items-center gap-1 px-2 py-1 text-[10px] text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              清除
            </button>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </div>

      {/* ── 展开内容 ── */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-4 border-t border-slate-100">

          {/* Step 1: JSON 配置 */}
          <div className="mt-3">
            <p className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-slate-700 text-white flex items-center justify-center text-[9px] font-bold flex-shrink-0">1</span>
              导入配置 JSON
              <span className="text-red-400">*</span>
            </p>

            <div
              onClick={() => jsonInputRef.current?.click()}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-slate-100 ${
                parsedNodes ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <FolderOpen className={`w-4 h-4 flex-shrink-0 ${parsedNodes ? 'text-blue-500' : 'text-slate-400'}`} />
              <div className="flex-1 min-w-0">
                {parsedNodes ? (
                  <div>
                    <p className="text-xs font-medium text-blue-700 truncate">{jsonFileName}</p>
                    <p className="text-[10px] text-blue-500 mt-0.5">
                      {parsedNodes.length === 1 ? '单节点配置' : `多节点配置 · ${parsedNodes.length} 个节点`}
                      {' · '}
                      {parsedNodes.map((n, i) => (
                        <span key={i} className="font-mono">{formatTimePrecise(n.interactionTime)}s{i < parsedNodes.length - 1 ? '、' : ''}</span>
                      ))}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">点击导入配置 JSON（支持 v1 单节点 / v2 多节点）</p>
                )}
              </div>
              {parsedNodes ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setParsedNodes(null); setJsonFileName('');
                    setNodeVideos([]); nodeVideoRefs.current = [];
                    setApplyStatus(null);
                  }}
                  className="text-slate-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              ) : (
                <Upload className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              )}
            </div>
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleJsonImport}
            />
          </div>

          {/* Step 2: 主视频 */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-slate-700 text-white flex items-center justify-center text-[9px] font-bold flex-shrink-0">2</span>
              主视频（原始视频）
              <span className="text-red-400">*</span>
            </p>
            <div onClick={() => mainVideoRef.current?.click()}>
              <MiniFileRow
                label="选择主视频文件"
                fileName={mainVideoName}
                onSelect={() => {}}
                onClear={() => { revokeUrl(mainVideoUrl); setMainVideoUrl(null); setMainVideoName(''); setApplyStatus(null); }}
                color="blue"
              />
            </div>
            <input ref={mainVideoRef} type="file" accept="video/*" className="hidden" onChange={handleMainVideoFile} />
          </div>

          {/* Step 3: 各节点视频 */}
          {parsedNodes && parsedNodes.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-slate-700 text-white flex items-center justify-center text-[9px] font-bold flex-shrink-0">3</span>
                各节点互动视频（可选）
              </p>

              <div className="flex flex-col gap-3">
                {parsedNodes.map((node, i) => {
                  const vids = nodeVideos[i] ?? {};
                  // 确保 refs 存在
                  if (!nodeVideoRefs.current[i]) {
                    nodeVideoRefs.current[i] = [React.createRef(), React.createRef(), React.createRef()];
                  }
                  const [waitRef, guidRef, fbRef] = nodeVideoRefs.current[i];

                  return (
                    <div key={i} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                      {/* 节点标题 */}
                      <div className="flex items-center gap-2 mb-2.5">
                        <span className="w-5 h-5 rounded-full bg-amber-400 text-white flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-xs font-semibold text-slate-700">
                          节点 #{i + 1}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          {formatTimePrecise(node.interactionTime)}s
                        </span>
                        <span className="text-[10px] text-slate-400">
                          裁剪: {node.cropArea?.width}×{node.cropArea?.height}
                        </span>
                        {node.croppedImageBase64 && (
                          <img
                            src={node.croppedImageBase64}
                            alt="avatar"
                            className="w-5 h-5 rounded object-cover border border-slate-200 ml-auto"
                          />
                        )}
                      </div>

                      {/* 视频槽 */}
                      <div className="grid grid-cols-3 gap-2 items-start">
                        {/* 等待视频列表 */}
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-[10px] text-orange-600 font-medium">等待视频 ({vids.waitingVideos?.length || 1})</p>
                            <button
                              type="button"
                              onClick={() => addNodeVideoListItem(i, 'waitingVideos')}
                              className="text-orange-500 hover:text-orange-700 hover:bg-orange-100 p-0.5 rounded transition-colors"
                              title="添加等待视频"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                          {vids.waitingVideos?.map((wv, wIdx) => (
                            <label key={wIdx} className="block cursor-pointer">
                              <MiniFileRow
                                label={`等待视频 ${wIdx + 1}`}
                                fileName={wv.name}
                                onSelect={() => {}}
                                onClear={() => removeNodeVideoListItem(i, 'waitingVideos', wIdx)}
                                color="orange"
                              />
                              <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(e) => handleNodeVideoListFile(e, i, 'waitingVideos', wIdx)}
                              />
                            </label>
                          ))}
                        </div>

                        {/* 引导语视频列表 */}
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-[10px] text-blue-600 font-medium">引导语视频 ({vids.guidanceVideos?.length || 1})</p>
                            <button
                              type="button"
                              onClick={() => addNodeVideoListItem(i, 'guidanceVideos')}
                              className="text-blue-500 hover:text-blue-700 hover:bg-blue-100 p-0.5 rounded transition-colors"
                              title="添加引导语"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                          {vids.guidanceVideos?.map((gv, gIdx) => (
                            <label key={gIdx} className="block cursor-pointer">
                              <MiniFileRow
                                label={`引导语 ${gIdx + 1}`}
                                fileName={gv.name}
                                onSelect={() => {}}
                                onClear={() => removeNodeVideoListItem(i, 'guidanceVideos', gIdx)}
                                color="blue"
                              />
                              <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(e) => handleNodeVideoListFile(e, i, 'guidanceVideos', gIdx)}
                              />
                            </label>
                          ))}
                        </div>

                        {/* 反馈语视频列表 */}
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between mb-0.5">
                            <p className="text-[10px] text-purple-600 font-medium">反馈语视频 ({vids.feedbackVideos?.length || 1})</p>
                            <button
                              type="button"
                              onClick={() => addNodeVideoListItem(i, 'feedbackVideos')}
                              className="text-purple-500 hover:text-purple-700 hover:bg-purple-100 p-0.5 rounded transition-colors"
                              title="添加反馈语"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                          {vids.feedbackVideos?.map((fv, fIdx) => (
                            <label key={fIdx} className="block cursor-pointer">
                              <MiniFileRow
                                label={`反馈语 ${fIdx + 1}`}
                                fileName={fv.name}
                                onSelect={() => {}}
                                onClear={() => removeNodeVideoListItem(i, 'feedbackVideos', fIdx)}
                                color="purple"
                              />
                              <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(e) => handleNodeVideoListFile(e, i, 'feedbackVideos', fIdx)}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 状态反馈 */}
          {applyStatus && (
            <div className={`flex items-center gap-2 p-2.5 rounded-lg text-xs ${
              applyStatus === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>
              {applyStatus === 'success' ? (
                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              )}
              {applyMessage}
            </div>
          )}

          {/* 应用按钮 */}
          <button
            onClick={handleApply}
            disabled={!parsedNodes || !mainVideoUrl}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Zap className="w-4 h-4" />
            应用 Demo（不调用后端 API）
          </button>
        </div>
      )}
    </div>
  );
};

export default DemoLoader;
