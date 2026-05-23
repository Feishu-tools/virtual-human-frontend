import React, { useState, useRef, useCallback } from 'react';
import Cropper from 'react-cropper';
import 'cropperjs/dist/cropper.css';
import { Upload, ZoomIn, ZoomOut, RotateCw, Info } from 'lucide-react';

const ImageCropper = ({ onCropComplete }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const cropperRef = useRef(null);
  const cropTimeoutRef = useRef(null);
  const [aspectRatio, setAspectRatio] = useState(384 / 256);

  const onFileChange = async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        setImageSrc(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const onCrop = useCallback(() => {
    requestAnimationFrame(() => {
      const cropper = cropperRef.current?.cropper;
      
      if (
        cropper && 
        typeof cropper.getCroppedCanvas === 'function' && 
        onCropComplete
      ) {
        try {
          const cropData = cropper.getData();
          
          if (!cropData || cropData.width === 0 || cropData.height === 0) {
            return;
          }

          const canvas = cropper.getCroppedCanvas(
            aspectRatio === 384 / 256 
              ? { width: 384, height: 256 } 
              : (aspectRatio === 256 / 384 ? { width: 256, height: 384 } : undefined)
          );
          if (canvas) {
            canvas.toBlob((blob) => {
              onCropComplete(blob);
            });
          }
        } catch (error) {
          console.error('ImageCropper: Error during crop', error);
        }
      }
    });
  }, [onCropComplete, aspectRatio]);

  const debouncedOnCrop = useCallback(() => {
    requestAnimationFrame(() => {
      onCrop();
    });
  }, [onCrop]);

  const handleZoomPin = useCallback((e) => {
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    const currentData = cropper.getData();
    setTimeout(() => {
      cropper.setData(currentData);
    }, 0);
  }, []);

  const handleZoomIn = () => {
    const cropper = cropperRef.current?.cropper;
    if (cropper) cropper.zoom(0.1);
  };

  const handleZoomOut = () => {
    const cropper = cropperRef.current?.cropper;
    if (cropper) cropper.zoom(-0.1);
  };

  const handleRotate = () => {
    const cropper = cropperRef.current?.cropper;
    if (cropper) cropper.rotate(90);
  };

  const handleAspectRatioChange = (e) => {
    const newRatio = Number(e.target.value);
    setAspectRatio(newRatio);
    const cropper = cropperRef.current?.cropper;
    if (cropper) {
      cropper.setAspectRatio(newRatio);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 rounded-xl overflow-hidden shadow-sm border border-slate-200">
      {!imageSrc ? (
        <div className="flex flex-col items-center justify-center h-full p-8 border-2 border-dashed border-slate-300 rounded-lg m-4 hover:bg-slate-100 transition-colors cursor-pointer relative group">
          <input
            type="file"
            onChange={onFileChange}
            accept="image/*"
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="bg-blue-100 p-4 rounded-full mb-4 group-hover:bg-blue-200 transition-colors">
            <Upload className="w-8 h-8 text-blue-600" />
          </div>
          <p className="text-lg font-medium text-slate-700">点击或拖拽上传图片</p>
          <p className="text-sm text-slate-500 mt-2">支持 JPG, PNG 等格式</p>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          <div className="relative flex-1 bg-slate-900 m-4 rounded-lg overflow-hidden flex flex-col items-center justify-center">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-black/60 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 pointer-events-none border border-white/10 shadow-lg">
              <Info className="w-3.5 h-3.5 text-amber-400" />
              当前画面将被截取为<span className="text-amber-400">参考帧</span>，用于等待态的生成，需要选取老师正常的图片
            </div>
            <Cropper
              ref={cropperRef}
              src={imageSrc}
              style={{ height: '100%', width: '100%' }}
              aspectRatio={aspectRatio}
              guides={false}
              viewMode={1}
              dragMode="crop"
              cropBoxMovable={true}
              cropBoxResizable={true}
              background={false}
              responsive={true}
              autoCropArea={0.5}
              modal={true}
              highlight={false}
              center={false}
              checkOrientation={false}
              restore={false}
              crop={debouncedOnCrop}
              zoom={handleZoomPin}
              className="cropper-container-custom"
            />
          </div>
          
          <div className="px-6 py-4 bg-white border-t border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button 
                onClick={handleZoomOut}
                className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-600"
                title="缩小"
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              
              <button 
                onClick={handleZoomIn}
                className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-600"
                title="放大"
              >
                <ZoomIn className="w-5 h-5" />
              </button>

              <div className="h-6 w-px bg-slate-300 mx-2"></div>

              <button 
                onClick={handleRotate}
                className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-600"
                title="旋转 90°"
              >
                <RotateCw className="w-5 h-5" />
              </button>

              <div className="h-6 w-px bg-slate-300 mx-2"></div>

              <select
                value={aspectRatio}
                onChange={handleAspectRatioChange}
                className="text-sm border border-slate-300 rounded-md px-2 py-1 bg-white text-slate-700 outline-none hover:border-slate-400 focus:border-blue-500 transition-colors"
              >
                <option value={1}>1:1 比例</option>
                <option value={384 / 256}>384:256 (横向) 比例</option>
                <option value={256 / 384}>256:384 (竖向) 比例</option>
              </select>
            </div>

            <button 
              onClick={() => {
                setImageSrc(null);
                cropperRef.current = null; // 清除图片时同时清理实例
              }}
              className="text-sm text-red-500 hover:text-red-700 px-4 py-2 hover:bg-red-50 rounded-md transition-colors"
            >
              重新上传
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageCropper;
