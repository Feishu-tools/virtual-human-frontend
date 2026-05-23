import React, { useEffect } from 'react';
import VideoFrameCropper from './components/VideoFrameCropper';
import ControlPanel from './components/ControlPanel';
import VideoPlayer from './components/VideoPlayer';
import DemoLoader from './components/DemoLoader';
import WaitingSimulator from './components/WaitingSimulator';
import useStore from './store/useStore';
import { Pencil, Eye, RefreshCcw } from 'lucide-react';
import './App.css';

function App() {
  const workspaceMode = useStore((s) => s.workspaceMode);
  const setWorkspaceMode = useStore((s) => s.setWorkspaceMode);

  // 全局空格键控制视频播放/暂停（无论当前在哪个面板）
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      useStore.getState()._videoTogglePlay?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen bg-slate-100 p-4 gap-4 overflow-hidden">
      {/* ═══ 左侧：统一视频工作区 ═══ */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col rounded-xl shadow-sm border border-slate-200 overflow-hidden relative bg-white">

          {/* ── 浮动模式切换器（始终悬浮在右上角） ── */}
          <div className="absolute top-3 right-3 z-[100] flex items-center bg-slate-900/60 backdrop-blur-md rounded-full p-[3px] shadow-lg border border-white/10">
            <button
              onClick={() => setWorkspaceMode('edit')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
                workspaceMode === 'edit'
                  ? 'bg-white text-slate-800 shadow-md'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              <Pencil className="w-3 h-3" />
              处理
            </button>
            <button
              onClick={() => setWorkspaceMode('preview')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
                workspaceMode === 'preview'
                  ? 'bg-white text-slate-800 shadow-md'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              <Eye className="w-3 h-3" />
              预览
            </button>
            <button
              onClick={() => setWorkspaceMode('waiting')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
                workspaceMode === 'waiting'
                  ? 'bg-white text-slate-800 shadow-md'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              <RefreshCcw className="w-3 h-3" />
              等待态模拟
            </button>
          </div>

          {/* ── 内容：使用 hidden 保持组件挂载，避免状态丢失 ── */}
          <div className={`h-full w-full ${workspaceMode === 'edit' ? 'block' : 'hidden'}`}>
            <VideoFrameCropper />
          </div>
          <div className={`h-full w-full ${workspaceMode === 'preview' ? 'block' : 'hidden'}`}>
            <VideoPlayer />
          </div>
          <div className={`h-full w-full ${workspaceMode === 'waiting' ? 'block' : 'hidden'}`}>
            <WaitingSimulator />
          </div>
        </div>
      </div>

      {/* ═══ 右侧：控制面板 ═══ */}
      <div className={`w-[520px] min-w-[480px] flex-shrink-0 h-full flex flex-col gap-3 ${workspaceMode === 'waiting' ? 'hidden' : 'flex'}`}>
        {/* <div className="flex-shrink-0">
          <DemoLoader />
        </div> */}

        <div className="flex-1 min-h-0 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <ControlPanel />
        </div>
      </div>
    </div>
  );
}

export default App;
