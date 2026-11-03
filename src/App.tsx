import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Box,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { openArchive, type RecordingArchive } from "./lib/archive";
import { prepareRecording, type Recording } from "./player/package";
const Player = lazy(() => import("./player/Player"));
import "./App.css";
import { MissingModel, importModel } from "./player/models";

export default function App() {
  const [recording, setRecording] = useState<Recording | null>(null),
    [generation, setGeneration] = useState(0);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(""),
    [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsModel, setNeedsModel] = useState(false);
  const modelInput = useRef<HTMLInputElement>(null),
    modelPending = useRef<AbortController | null>(null),
    awaitingModel = useRef<{ file: File; hash: string } | null>(null);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<AbortController | null>(null),
    current = useRef<Recording | null>(null),
    dragDepth = useRef(0);
  useEffect(
    () => () => {
      pending.current?.abort();
      modelPending.current?.abort();
      const previous = current.current;
      current.current = null;
      previous?.dispose();
    },
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const fail = useCallback((source: Recording, message: string) => {
    if (current.current !== source) return;
    current.current = null;
    source.dispose();
    setRecording(null);
    setError(`预览失败：${message}。请重新打开录制包。`);
  }, []);
  async function open(file: File) {
    pending.current?.abort();
    modelPending.current?.abort();
    awaitingModel.current = null;
    setNeedsModel(false);
    const controller = new AbortController();
    pending.current = controller;
    setLoading("正在读取录制包…");
    setError("");
    setDragging(false);
    dragDepth.current = 0;
    let archive: RecordingArchive | undefined;
    try {
      archive = await openArchive(file, controller.signal, () => {});
      const next = await prepareRecording(
        archive,
        controller.signal,
        (text) => {
          if (!controller.signal.aborted) setLoading(text);
        },
      );
      if (controller.signal.aborted) {
        next.dispose();
        return;
      }
      const previous = current.current;
      current.current = next;
      previous?.dispose();
      setRecording(next);
      setGeneration((value) => value + 1);
    } catch (error) {
      archive?.close();
      if (!controller.signal.aborted) {
        if (error instanceof MissingModel) {
          awaitingModel.current = { file, hash: error.hash };
          setNeedsModel(true);
          setError(error.message);
        } else setError(`无法打开录制包：${(error as Error).message}`);
      }
    } finally {
      if (!controller.signal.aborted) setLoading("");
    }
  }
  async function cacheModel(file: File) {
    pending.current?.abort();
    modelPending.current?.abort();
    const controller = new AbortController(), waiting = awaitingModel.current;
    modelPending.current = controller;
    setLoading("正在缓存模型…"); setError("");
    try {
      await importModel(file, controller.signal, waiting?.hash);
      if (controller.signal.aborted) return;
      setNotice("模型已缓存");
      if (waiting && awaitingModel.current === waiting) await open(waiting.file);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading("");
    }
  }
  function close() {
    pending.current?.abort();
    modelPending.current?.abort();
    awaitingModel.current = null;
    setNeedsModel(false);
    const previous = current.current;
    current.current = null;
    previous?.dispose();
    setRecording(null);
    setLoading("");
    setError("");
  }
  return (
    <main
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = event.dataTransfer.files;
        if (files.length !== 1) {
          setError("请一次打开一个 ZIP 录制包");
          return;
        }
        if (/\.npz$/i.test(files[0].name)) void cacheModel(files[0]);
        else void open(files[0]);
      }}
    >
      <header className="app-header">
        <a className="brand" href="./" aria-label="SynaExo Viewer 首页">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <span>
            SynaExo <b>Viewer</b>
          </span>
        </a>
        <div className="header-actions">
          {recording && !recording.qualityPassed && (
            <span
              className="quality-warning"
              title="源结果未通过物理精度检查"
              aria-label="源结果未通过物理精度检查"
            >
              <TriangleAlert />
            </span>
          )}
          {recording && (
            <button
              className="icon-button"
              aria-label="关闭录制包"
              title="关闭录制包"
              onClick={close}
            >
              <X />
            </button>
          )}
          <button onClick={() => modelInput.current?.click()} title="导入并缓存 SMPL-X 模型">
            <Box />
            导入模型
          </button>
          <button onClick={() => input.current?.click()}>
            <FolderOpen />
            打开 ZIP
          </button>
        </div>
      </header>
      <input ref={modelInput} type="file" accept=".npz" aria-label="SMPL-X 模型" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void cacheModel(file);
          event.target.value = "";
        }} />
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void open(file);
          event.target.value = "";
        }}
      />
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          {needsModel && <button onClick={() => modelInput.current?.click()}>选择模型</button>}
          <button
            className="icon-button"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => { setError(""); awaitingModel.current = null; setNeedsModel(false); }}
          >
            <X />
          </button>
        </div>
      )}
      {recording ? (
        <Suspense
          fallback={
            <div className="view-loading" role="status">
              <LoaderCircle className="spin" />
              正在准备视图…
            </div>
          }
        >
          <Player
            key={generation}
            recording={recording}
            onError={fail}
            suspended={!!loading}
          />
        </Suspense>
      ) : (
        <section className="empty-workspace">
          <div className="drop-zone">
            <div className="archive-symbol">
              <FileArchive />
            </div>
            <h1>打开录制包</h1>
            <p>拖入 ZIP，或选择文件</p>
            <button className="primary" onClick={() => input.current?.click()}>
              <FolderOpen />
              选择 ZIP
            </button>
            <span className="local-note">本地读取，不上传文件</span>
          </div>
        </section>
      )}
      {loading && (
        <div className="import-overlay" role="status">
          <LoaderCircle className="spin" />
          <span>{loading}</span>
          <button
            onClick={() => {
              pending.current?.abort();
              modelPending.current?.abort();
              awaitingModel.current = null;
              setNeedsModel(false);
              setLoading("");
            }}
          >
            <ArrowLeft />
            取消
          </button>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
      {dragging && (
        <div className="drag-overlay">
          <FileArchive />
          <span>松开以打开录制包</span>
        </div>
      )}
    </main>
  );
}
