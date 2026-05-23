import React, { useState } from 'react';
import WaitingSimulatorV1 from './WaitingSimulatorV1';
import WaitingSimulatorV2 from './WaitingSimulatorV2';
import WaitingSimulatorV3 from './WaitingSimulatorV3';

export default function WaitingSimulator() {
  const [version, setVersion] = useState('v2');

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex justify-center border-b border-slate-200 p-2 shrink-0">
        <div className="bg-slate-100 p-1 rounded-lg flex gap-1">
          <button
            onClick={() => setVersion('v1')}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              version === 'v1' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            方案 1 (随机目标跳转)
          </button>
          <button
            onClick={() => setVersion('v2')}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              version === 'v2' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            方案 2 (ABC 片段接力)
          </button>
          <button
            onClick={() => setVersion('v3')}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              version === 'v3' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            方案 3 (AB 乒乓变速)
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {version === 'v1' && <WaitingSimulatorV1 />}
        {version === 'v2' && <WaitingSimulatorV2 />}
        {version === 'v3' && <WaitingSimulatorV3 />}
      </div>
    </div>
  );
}
