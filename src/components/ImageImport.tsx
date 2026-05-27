import {
  ClipboardPaste,
  ImageUp,
  RefreshCw,
  RotateCcw,
  ScreenShare,
  ScreenShareOff,
} from "lucide-react";
import { useState } from "react";
import type { RecognitionProgress } from "../lib/imageRecognition";

interface ImageImportProps {
  isBusy: boolean;
  isScreenSharing: boolean;
  progress: RecognitionProgress | null;
  warnings: string[];
  onClear: () => void;
  onFile: (file: File) => void;
  onForceScreenRecognition: () => void;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
}

export function ImageImport({
  isBusy,
  isScreenSharing,
  progress,
  warnings,
  onClear,
  onFile,
  onForceScreenRecognition,
  onStartScreenShare,
  onStopScreenShare,
}: ImageImportProps) {
  const [isDragging, setIsDragging] = useState(false);
  const isFileDisabled = isBusy || isScreenSharing;

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);

    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
    if (file && !isFileDisabled) {
      onFile(file);
    }
  };

  return (
    <section
      className={`import-panel ${isDragging ? "is-dragging" : ""}`}
      aria-label="스크린샷 입력"
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragging(false);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="import-actions">
        <label className="icon-button file-button">
          <ImageUp size={18} />
          <span>업로드</span>
          <input
            accept="image/*"
            disabled={isFileDisabled}
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onFile(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
        <div className="paste-chip">
          <ClipboardPaste size={18} />
          <span>붙여넣기</span>
        </div>
        <button
          className={`icon-button screen-button ${isScreenSharing ? "is-live" : ""}`}
          disabled={isBusy && !isScreenSharing}
          type="button"
          onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
        >
          {isScreenSharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
          <span>{isScreenSharing ? "중지" : "화면"}</span>
        </button>
        <button
          className="icon-button ghost-button"
          disabled={isBusy && isScreenSharing}
          type="button"
          onClick={isScreenSharing ? onForceScreenRecognition : onClear}
        >
          {isScreenSharing ? <RefreshCw size={18} /> : <RotateCcw size={18} />}
          <span>{isScreenSharing ? "재인식" : "초기화"}</span>
        </button>
      </div>
      {isScreenSharing && !isBusy && (
        <div className="live-status" role="status">
          <span />
          <strong>화면 공유 중</strong>
        </div>
      )}
      {isBusy && (
        <div className="progress-wrap" role="status">
          <div className="progress-line">
            <span>{progress?.message ?? "처리 중"}</span>
            <span>{Math.round((progress?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </section>
  );
}
