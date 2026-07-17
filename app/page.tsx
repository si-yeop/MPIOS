"use client";

import { ChangeEvent, PointerEvent, WheelEvent, useEffect, useRef, useState } from "react";

const DEFAULT_DURATION = 183;
const IDLE_WAVE = [0.24, 0.5, 0.82, 0.42, 0.66, 0.3];

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

type Sticker = {
  id: string;
  src: string;
  x: number;
  y: number;
  size: number;
  aspect: number;
};

type PlayerTemplate = {
  version: 1;
  title: string;
  artist: string;
  device: string;
  accent: string;
  transparentBackground: boolean;
  cover: string | null;
  coverScale: number;
  coverFocus: { x: number; y: number };
  stickers: Sticker[];
  volume: number;
};

type SavedTemplate = {
  id: string;
  name: string;
  saved_at: number;
};

type StoredTemplate = SavedTemplate & {
  template: PlayerTemplate;
};

const TEMPLATE_DB_NAME = "vinylab-player";
const TEMPLATE_STORE_NAME = "templates";

function openTemplateDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("이 브라우저에서는 템플릿 저장을 지원하지 않습니다."));
      return;
    }
    const request = indexedDB.open(TEMPLATE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
        request.result.createObjectStore(TEMPLATE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("브라우저 저장 공간을 열지 못했습니다."));
  });
}

function waitForRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("브라우저 저장 요청에 실패했습니다."));
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("브라우저 저장에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error ?? new Error("브라우저 저장이 취소되었습니다."));
  });
}

async function listBrowserTemplates() {
  const database = await openTemplateDatabase();
  try {
    const transaction = database.transaction(TEMPLATE_STORE_NAME, "readonly");
    const stored = await waitForRequest(transaction.objectStore(TEMPLATE_STORE_NAME).getAll()) as StoredTemplate[];
    return stored
      .map(({ id, name, saved_at }) => ({ id, name, saved_at }))
      .sort((a, b) => b.saved_at - a.saved_at);
  } finally {
    database.close();
  }
}

async function saveBrowserTemplate(template: StoredTemplate) {
  const database = await openTemplateDatabase();
  try {
    const transaction = database.transaction(TEMPLATE_STORE_NAME, "readwrite");
    transaction.objectStore(TEMPLATE_STORE_NAME).put(template);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

async function getBrowserTemplate(id: string) {
  const database = await openTemplateDatabase();
  try {
    const transaction = database.transaction(TEMPLATE_STORE_NAME, "readonly");
    return await waitForRequest(transaction.objectStore(TEMPLATE_STORE_NAME).get(id)) as StoredTemplate | undefined;
  } finally {
    database.close();
  }
}

async function deleteBrowserTemplate(id: string) {
  const database = await openTemplateDatabase();
  try {
    const transaction = database.transaction(TEMPLATE_STORE_NAME, "readwrite");
    transaction.objectStore(TEMPLATE_STORE_NAME).delete(id);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export default function Home() {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [device, setDevice] = useState("iPhone");
  const [accent, setAccent] = useState("#0b789f");
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [cover, setCover] = useState<string | null>(null);
  const [coverScale, setCoverScale] = useState(1);
  const [coverFocus, setCoverFocus] = useState({ x: 50, y: 50 });
  const [isDragging, setIsDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(7);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [volume, setVolume] = useState(62);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioName, setAudioName] = useState("");
  const [waveLevels, setWaveLevels] = useState(IDLE_WAVE);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
  const stickerFileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const dragRef = useRef({ pointerId: -1, startX: 0, startY: 0, originX: 50, originY: 50, width: 76, height: 76 });
  const stickerInteractionRef = useRef<{
    pointerId: number;
    stickerId: string;
    mode: "drag" | "resize" | null;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originSize: number;
    width: number;
    height: number;
  }>({
    pointerId: -1,
    stickerId: "",
    mode: null,
    startX: 0,
    startY: 0,
    originX: 50,
    originY: 50,
    originSize: 18,
    width: 1,
    height: 1,
  });

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100;
  }, [volume]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    if (!isPlaying || !analyserRef.current) {
      setWaveLevels(IDLE_WAVE);
      return;
    }

    const analyser = analyserRef.current;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let animationFrame = 0;
    const updateWave = () => {
      analyser.getByteFrequencyData(data);
      const bucket = Math.max(1, Math.floor(data.length / 6));
      setWaveLevels(Array.from({ length: 6 }, (_, index) => {
        let total = 0;
        for (let offset = 0; offset < bucket; offset += 1) {
          total += data[Math.min(data.length - 1, index * bucket + offset)];
        }
        return Math.max(0.14, total / bucket / 255);
      }));
      animationFrame = requestAnimationFrame(updateWave);
    };
    updateWave();
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying]);

  useEffect(() => {
    let cancelled = false;
    const loadSavedTemplates = async () => {
      try {
        const templates = await listBrowserTemplates();
        if (!cancelled) setSavedTemplates(templates);
      } catch {
        // The editor remains usable even when saved templates are unavailable.
      }
    };
    void loadSavedTemplates();
    return () => { cancelled = true; };
  }, []);

  const handleCover = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCover(String(reader.result));
      setCoverScale(1);
      setCoverFocus({ x: 50, y: 50 });
    };
    reader.readAsDataURL(file);
  };

  const handleAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const nextUrl = URL.createObjectURL(file);
    setAudioUrl(nextUrl);
    setAudioName(file.name);
    setCurrentTime(0);
    setIsPlaying(false);
  };

  const handleStickers = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    files.forEach((file, fileIndex) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const image = new Image();
        image.onload = () => {
          const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
          const maxSizeForHeight = 100 * (560 * aspect / 990) * 0.86;
          const size = Math.max(6, Math.min(18, maxSizeForHeight));
          setStickers((current) => [
            ...current,
            {
              id: `${Date.now()}-${fileIndex}-${Math.random().toString(36).slice(2)}`,
              src,
              x: 50,
              y: 50,
              size,
              aspect,
            },
          ]);
        };
        image.src = src;
      };
      reader.readAsDataURL(file);
    });
    event.target.value = "";
  };

  const clampStickerPosition = (
    x: number,
    y: number,
    size: number,
    aspect: number,
    width: number,
    height: number,
  ) => {
    const stageMarginX = (105 / 990) * 100;
    const stageMarginY = (100 / 560) * 100;
    const halfWidth = size / 2;
    const halfHeight = ((width * size / 100) / Math.max(0.01, aspect) / height) * 50;
    return {
      x: Math.min(100 + stageMarginX - halfWidth, Math.max(-stageMarginX + halfWidth, x)),
      y: Math.min(100 + stageMarginY - halfHeight, Math.max(-stageMarginY + halfHeight, y)),
    };
  };

  const startStickerInteraction = (
    event: PointerEvent<HTMLElement>,
    sticker: Sticker,
    mode: "drag" | "resize",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const card = event.currentTarget.closest(".player-card");
    const bounds = card?.getBoundingClientRect();
    if (!bounds) return;
    stickerInteractionRef.current = {
      pointerId: event.pointerId,
      stickerId: sticker.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originX: sticker.x,
      originY: sticker.y,
      originSize: sticker.size,
      width: bounds.width,
      height: bounds.height,
    };
  };

  const moveSticker = (event: PointerEvent<HTMLElement>) => {
    const interaction = stickerInteractionRef.current;
    if (interaction.pointerId !== event.pointerId || !interaction.mode) return;
    event.preventDefault();
    const deltaX = event.clientX - interaction.startX;
    const deltaY = event.clientY - interaction.startY;
    setStickers((current) => current.map((sticker) => {
      if (sticker.id !== interaction.stickerId) return sticker;
      if (interaction.mode === "resize") {
        const stageHeightInCardPercent = 100 + 2 * (100 / 560) * 100;
        const maxSizeByHeight = stageHeightInCardPercent * (interaction.height * sticker.aspect / interaction.width);
        const nextSize = Math.min(90, Math.max(4, Math.min(maxSizeByHeight, interaction.originSize + (deltaX / interaction.width) * 100)));
        const clamped = clampStickerPosition(sticker.x, sticker.y, nextSize, sticker.aspect, interaction.width, interaction.height);
        return { ...sticker, ...clamped, size: nextSize };
      }
      const nextX = interaction.originX + (deltaX / interaction.width) * 100;
      const nextY = interaction.originY + (deltaY / interaction.height) * 100;
      return { ...sticker, ...clampStickerPosition(nextX, nextY, sticker.size, sticker.aspect, interaction.width, interaction.height) };
    }));
  };

  const stopStickerInteraction = (event: PointerEvent<HTMLElement>) => {
    if (stickerInteractionRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stickerInteractionRef.current.pointerId = -1;
    stickerInteractionRef.current.mode = null;
  };

  const setupAudioGraph = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioContextRef.current && analyserRef.current) {
      await audioContextRef.current.resume();
      return;
    }

    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    const recordingDestination = context.createMediaStreamDestination();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    analyser.connect(context.destination);
    analyser.connect(recordingDestination);
    audioContextRef.current = context;
    analyserRef.current = analyser;
    recordingDestinationRef.current = recordingDestination;
    await context.resume();
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audioUrl || !audio) {
      audioFileRef.current?.click();
      return;
    }
    await setupAudioGraph();
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  };

  const seekTo = (nextTime: number) => {
    const safeTime = Math.min(duration, Math.max(0, nextTime));
    setCurrentTime(safeTime);
    if (audioRef.current && audioUrl) audioRef.current.currentTime = safeTime;
  };

  const startCoverDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!cover) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    if (coverScale <= 1.01) setCoverScale(1.15);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: coverFocus.x,
      originY: coverFocus.y,
      width: bounds.width,
      height: bounds.height,
    };
    setIsDragging(true);
  };

  const moveCover = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isDragging || dragRef.current.pointerId !== event.pointerId) return;
    setCoverFocus({
      x: Math.min(100, Math.max(0, dragRef.current.originX - ((event.clientX - dragRef.current.startX) / dragRef.current.width) * 100)),
      y: Math.min(100, Math.max(0, dragRef.current.originY - ((event.clientY - dragRef.current.startY) / dragRef.current.height) * 100)),
    });
  };

  const stopCoverDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current.pointerId = -1;
    setIsDragging(false);
  };

  const zoomCover = (event: WheelEvent<HTMLButtonElement>) => {
    if (!cover) return;
    event.preventDefault();
    setCoverScale((scale) => Math.min(4, Math.max(1, scale - event.deltaY * 0.002)));
  };

  const skip = (amount: number) => {
    seekTo(currentTime + amount);
  };

  const createExportCanvas = async (
    playhead = currentTime,
    waveformPhase = -1,
    cachedCover?: HTMLImageElement | null,
    cachedStickerImages?: Map<string, HTMLImageElement>,
    targetCanvas?: HTMLCanvasElement,
  ) => {
    const canvas = targetCanvas ?? document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 760;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!transparentBackground) {
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = "#ffffff";
      for (let y = 28; y < canvas.height; y += 42) {
        for (let x = 28; x < canvas.width; x += 42) {
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.shadowColor = "rgba(0,0,0,.25)";
    ctx.shadowBlur = 38;
    ctx.shadowOffsetY = 24;
    const cardGradient = ctx.createLinearGradient(105, 100, 1095, 660);
    cardGradient.addColorStop(0, "#f2f2ee");
    cardGradient.addColorStop(1, "#d3d4d0");
    ctx.fillStyle = cardGradient;
    ctx.beginPath();
    ctx.roundRect(105, 100, 990, 560, 42);
    ctx.fill();
    ctx.shadowColor = "transparent";

    const coverX = 190;
    const coverY = 175;
    const coverSize = 165;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(coverX, coverY, coverSize, coverSize, 20);
    ctx.clip();
    if (cover) {
      const image = cachedCover ?? await loadImage(cover);
      const baseScale = Math.max(coverSize / image.width, coverSize / image.height);
      const width = image.width * baseScale * coverScale;
      const height = image.height * baseScale * coverScale;
      const rawX = coverX + coverSize / 2 - width * (coverFocus.x / 100);
      const rawY = coverY + coverSize / 2 - height * (coverFocus.y / 100);
      const drawX = Math.min(coverX, Math.max(coverX + coverSize - width, rawX));
      const drawY = Math.min(coverY, Math.max(coverY + coverSize - height, rawY));
      ctx.drawImage(
        image,
        drawX,
        drawY,
        width,
        height,
      );
    } else {
      ctx.fillStyle = "#e6fb4d";
      ctx.fillRect(coverX, coverY, coverSize, coverSize);
      ctx.fillStyle = "#126b9d";
      ctx.textAlign = "center";
      ctx.font = '800 38px "Manrope", "Noto Sans KR", Arial, sans-serif';
      ctx.fillText("YOUR", coverX + coverSize / 2, coverY + 75);
      ctx.fillText("VIBE", coverX + coverSize / 2, coverY + 118);
    }
    ctx.restore();

    ctx.textAlign = "left";
    ctx.fillStyle = "#888a86";
    ctx.font = '700 24px "Manrope", "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(device || "iPhone", 395, 207);
    ctx.fillStyle = "#242624";
    ctx.font = '700 48px "Manrope", "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(title.slice(0, 24), 395, 263);
    ctx.fillStyle = "#656763";
    ctx.font = '28px "Manrope", "Noto Sans KR", Arial, sans-serif';
    ctx.fillText([artist.slice(0, 18), title.slice(0, 18)].filter(Boolean).join(" — "), 395, 306);

    const bars = [24, 48, 70, 40, 58, 30];
    bars.forEach((height, index) => {
      const animatedHeight = waveformPhase >= 0
        ? height * (0.42 + Math.abs(Math.sin(waveformPhase + index * 1.13)) * 0.58)
        : height;
      ctx.fillStyle = "#5e615e";
      ctx.beginPath();
      ctx.roundRect(946 + index * 13, 248 - animatedHeight / 2, 7, animatedHeight, 4);
      ctx.fill();
    });

    const lineX = 190;
    const lineY = 398;
    const lineWidth = 820;
    ctx.fillStyle = "rgba(44,45,44,.16)";
    ctx.fillRect(lineX, lineY, lineWidth, 5);
    ctx.fillStyle = "#2c2d2c";
    const trackDuration = Math.max(1, duration);
    const progress = (playhead % trackDuration) / trackDuration;
    ctx.fillRect(lineX, lineY, lineWidth * progress, 5);
    ctx.beginPath();
    ctx.arc(lineX + lineWidth * progress, lineY + 2.5, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.fillStyle = "#242624";
    ctx.font = '600 24px "Manrope", "Noto Sans KR", Arial, sans-serif';
    ctx.fillText(formatTime(playhead % trackDuration), lineX, 442);
    ctx.textAlign = "right";
    ctx.fillText(`-${formatTime(trackDuration - (playhead % trackDuration))}`, lineX + lineWidth, 442);

    ctx.textAlign = "center";
    ctx.fillStyle = "#898b88";
    ctx.font = '700 62px "Manrope", "Noto Sans KR", Arial, sans-serif';
    ctx.fillText("◀◀", 405, 546);
    ctx.fillStyle = "#242624";
    if (waveformPhase >= 0 || isPlaying) {
      ctx.beginPath();
      ctx.roundRect(568, 484, 19, 72, 4);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(613, 484, 19, 72, 4);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(574, 482);
      ctx.lineTo(574, 558);
      ctx.lineTo(638, 520);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillText("▶▶", 795, 546);

    ctx.fillStyle = "rgba(44,45,44,.16)";
    ctx.fillRect(240, 602, 720, 5);
    ctx.fillStyle = "#2c2d2c";
    ctx.fillRect(240, 602, 720 * (volume / 100), 5);
    ctx.beginPath();
    ctx.arc(240 + 720 * (volume / 100), 604.5, 11, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    for (const sticker of stickers) {
      const image = cachedStickerImages?.get(sticker.id) ?? await loadImage(sticker.src);
      const stickerWidth = 990 * (sticker.size / 100);
      const stickerHeight = stickerWidth / Math.max(0.01, sticker.aspect);
      const stickerX = 105 + 990 * (sticker.x / 100) - stickerWidth / 2;
      const stickerY = 100 + 560 * (sticker.y / 100) - stickerHeight / 2;
      ctx.drawImage(image, stickerX, stickerY, stickerWidth, stickerHeight);
    }

    return canvas;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const savePng = async () => {
    const canvas = await createExportCanvas();
    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, "vinylab-player.png");
    }, "image/png");
  };

  const currentTemplate = (): PlayerTemplate => ({
      version: 1,
      title,
      artist,
      device,
      accent,
      transparentBackground,
      cover,
      coverScale,
      coverFocus,
      stickers,
      volume,
  });

  const refreshTemplates = async (preferredId = selectedTemplateId) => {
    const templates = await listBrowserTemplates();
    setSavedTemplates(templates);
    if (preferredId && templates.some((template) => template.id === preferredId)) {
      setSelectedTemplateId(preferredId);
    } else {
      setSelectedTemplateId(templates[0]?.id ?? "");
    }
  };

  const applyTemplate = (template: Partial<PlayerTemplate>) => {
    if (template.version !== 1) throw new Error("지원하지 않는 템플릿입니다.");
    setTitle(typeof template.title === "string" ? template.title : "");
    setArtist(typeof template.artist === "string" ? template.artist : "");
    setDevice(typeof template.device === "string" ? template.device : "iPhone");
    if (typeof template.accent === "string" && /^#[0-9a-f]{6}$/i.test(template.accent)) {
      setAccent(template.accent);
    }
    setTransparentBackground(template.transparentBackground !== false);
    setCover(typeof template.cover === "string" ? template.cover : null);
    setCoverScale(typeof template.coverScale === "number" ? Math.min(4, Math.max(1, template.coverScale)) : 1);
    const focus = template.coverFocus;
    setCoverFocus({
      x: typeof focus?.x === "number" ? Math.min(100, Math.max(0, focus.x)) : 50,
      y: typeof focus?.y === "number" ? Math.min(100, Math.max(0, focus.y)) : 50,
    });
    setStickers(Array.isArray(template.stickers)
      ? template.stickers.filter((sticker): sticker is Sticker => (
        typeof sticker?.id === "string"
        && typeof sticker?.src === "string"
        && typeof sticker?.x === "number"
        && typeof sticker?.y === "number"
        && typeof sticker?.size === "number"
        && typeof sticker?.aspect === "number"
      ))
      : []);
    setVolume(typeof template.volume === "number" ? Math.min(100, Math.max(0, template.volume)) : 62);
  };

  const saveTemplate = async () => {
    const suggestedName = `템플릿 ${savedTemplates.length + 1}`;
    const name = window.prompt("저장할 템플릿 이름을 입력해주세요.", suggestedName)?.trim();
    if (!name) return;
    setTemplateBusy(true);
    try {
      const id = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await saveBrowserTemplate({ id, name: name.slice(0, 60), saved_at: Date.now(), template: currentTemplate() });
      await refreshTemplates(id);
      window.alert("이 브라우저에 템플릿을 저장했습니다.");
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : "템플릿을 저장하지 못했습니다.");
    } finally {
      setTemplateBusy(false);
    }
  };

  const loadTemplate = async () => {
    if (!selectedTemplateId) return;
    setTemplateBusy(true);
    try {
      const stored = await getBrowserTemplate(selectedTemplateId);
      if (!stored) throw new Error("템플릿을 찾을 수 없습니다.");
      applyTemplate(stored.template);
      window.alert("템플릿을 불러왔습니다. 음악 파일은 템플릿에 포함되지 않습니다.");
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : "템플릿을 불러오지 못했습니다.");
    } finally {
      setTemplateBusy(false);
    }
  };

  const deleteTemplate = async () => {
    if (!selectedTemplateId) return;
    const selected = savedTemplates.find((template) => template.id === selectedTemplateId);
    if (!window.confirm(`'${selected?.name ?? "선택한 템플릿"}'을 삭제할까요?`)) return;
    setTemplateBusy(true);
    try {
      await deleteBrowserTemplate(selectedTemplateId);
      await refreshTemplates("");
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : "템플릿을 삭제하지 못했습니다.");
    } finally {
      setTemplateBusy(false);
    }
  };

  const saveVideo = async () => {
    if (typeof MediaRecorder === "undefined") {
      window.alert("이 브라우저에서는 동영상 저장을 지원하지 않습니다.");
      return;
    }
    const audio = audioRef.current;
    if (!audioUrl || !audio) {
      window.alert("음악 파일을 먼저 넣어주세요.");
      return;
    }

    const mimeType = [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      "video/mp4;codecs=avc1.42001E,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
      "video/mp4",
    ]
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      window.alert("현재 브라우저는 MP4 녹화를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 다시 시도해주세요.");
      return;
    }

    const originalTime = audio.currentTime;
    const wasPaused = audio.paused;
    let canvasStream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let animationFrame = 0;

    setIsExporting(true);
    setExportProgress(0);

    try {
      const coverImage = cover ? await loadImage(cover) : null;
      const stickerImages = new Map<string, HTMLImageElement>();
      await Promise.all(stickers.map(async (sticker) => {
        stickerImages.set(sticker.id, await loadImage(sticker.src));
      }));

      audio.pause();
      audio.currentTime = 0;
      setCurrentTime(0);
      await setupAudioGraph();

      const fullDuration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : duration;
      const recordingDuration = Math.max(1000, Math.ceil(fullDuration * 1000));
      const canvas = await createExportCanvas(0, 0, coverImage, stickerImages);
      canvasStream = canvas.captureStream(30);
      const audioTracks = recordingDestinationRef.current?.stream.getAudioTracks() ?? [];
      const stream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks,
      ]);
      recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];
      const finished = new Promise<Blob>((resolve, reject) => {
        if (!recorder) return reject(new Error("녹화기를 시작하지 못했습니다."));
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error("MP4 녹화 중 오류가 발생했습니다."));
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      });

      await audio.play();
      const startedAt = performance.now();
      let lastProgressTick = -1;
      recorder.start(1000);

      const drawNextFrame = (now: number) => {
        const elapsed = Math.min(now - startedAt, recordingDuration);
        void createExportCanvas(
          elapsed / 1000,
          elapsed / 180,
          coverImage,
          stickerImages,
          canvas,
        );
        const progressTick = Math.floor(elapsed / 250);
        if (progressTick !== lastProgressTick) {
          lastProgressTick = progressTick;
          setExportProgress((elapsed / recordingDuration) * 100);
        }
        if (elapsed < recordingDuration) {
          animationFrame = requestAnimationFrame(drawNextFrame);
        } else if (recorder?.state !== "inactive") {
          setExportProgress(100);
          recorder?.stop();
        }
      };
      animationFrame = requestAnimationFrame(drawNextFrame);

      const video = await finished;
      downloadBlob(video, "vinylab-player.mp4");
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : "MP4 저장 중 오류가 발생했습니다.");
    } finally {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (recorder?.state === "recording") recorder.stop();
      canvasStream?.getTracks().forEach((track) => track.stop());
      audio.pause();
      audio.currentTime = Math.min(originalTime, Number.isFinite(audio.duration) ? audio.duration : originalTime);
      setCurrentTime(audio.currentTime);
      if (!wasPaused) {
        try {
          await audio.play();
        } catch {
          // The browser may require another click before resuming playback.
        }
      }
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  return (
    <main className="site-shell" style={{ "--accent": accent } as React.CSSProperties}>
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const nextDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : DEFAULT_DURATION;
          setDuration(nextDuration);
          setCurrentTime(0);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="Vinylab 처음으로">
          <span className="brand-mark">V</span>
          <span>VINYLAB</span>
        </a>
        <span className="top-note">나만의 플레이어를 만들어보세요</span>
      </header>

      <section className="hero" id="top">
        <div className="intro">
          <p className="eyebrow"><span /> NOW PLAYING — YOUR EDIT</p>
          <h1>좋아하는 순간을<br /><em>한 장의 플레이어로.</em></h1>
          <p className="description">
            앨범 커버와 곡 정보를 바꾸면 오른쪽 플레이어에 바로 반영돼요.
            재생 버튼과 슬라이더도 직접 눌러보세요.
          </p>

          <div className="editor-card">
            <div className="editor-head">
              <div><p>PLAYER EDITOR</p><h2>재생 정보 편집</h2></div>
              <span className="live-pill"><i /> LIVE</span>
            </div>

            <div className="fields">
              <label><span>곡 제목</span><input value={title} maxLength={36} onChange={(e) => setTitle(e.target.value)} placeholder="곡 제목을 입력하세요" /></label>
              <label><span>가수</span><input value={artist} maxLength={36} onChange={(e) => setArtist(e.target.value)} placeholder="가수명을 입력하세요" /></label>
              <label><span>기기 이름</span><input value={device} maxLength={18} onChange={(e) => setDevice(e.target.value)} placeholder="iPhone" /></label>
              <label className="color-field">
                <span>배경 컬러</span>
                <div className="color-control">
                  <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="배경 컬러 선택" />
                  <code>{accent.toUpperCase()}</code>
                  <button
                    className={`transparency-toggle ${transparentBackground ? "active" : ""}`}
                    type="button"
                    onClick={() => setTransparentBackground((transparent) => !transparent)}
                    aria-pressed={transparentBackground}
                  >
                    투명
                  </button>
                </div>
              </label>
            </div>

            <input ref={fileRef} className="file-input" type="file" accept="image/*" onChange={handleCover} />
            <input ref={audioFileRef} className="file-input" type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/*" onChange={handleAudio} />
            <input ref={stickerFileRef} className="file-input" type="file" accept="image/*" multiple onChange={handleStickers} />
            <div className="action-row">
              <button className="upload-button" type="button" onClick={() => fileRef.current?.click()}>
                <span className="upload-icon">＋</span>
                <span><strong>앨범 커버 바꾸기</strong><small>JPG, PNG, WEBP</small></span>
                <span className="upload-arrow">→</span>
              </button>
              <button className="upload-button audio-upload-button" type="button" onClick={() => audioFileRef.current?.click()}>
                <span className="upload-icon audio-upload-icon">♪</span>
                <span><strong>음악 파일 넣기</strong><small>{audioName || "MP3, M4A, WAV"}</small></span>
                <span className="upload-arrow">→</span>
              </button>
              <button className="save-button" type="button" onClick={savePng} aria-label="PNG로 저장">
                <span className="download-icon">↓</span><strong>PNG 저장</strong>
              </button>
              <button className="save-button video-button" type="button" onClick={saveVideo} disabled={isExporting} aria-label="MP4로 저장">
                <span className="video-icon">{isExporting ? "…" : "●"}</span>
                <strong>{isExporting ? `${Math.round(exportProgress)}%` : "MP4 저장"}</strong>
              </button>
            </div>
            <button className="sticker-add-button" type="button" onClick={() => stickerFileRef.current?.click()}>
              <span>✦</span>
              <strong>스티커 이미지 추가</strong>
              <small>PNG, JPG, WEBP · 여러 장 가능</small>
            </button>
            <div className="template-manager">
              <div className="template-manager-head">
                <strong>내 템플릿</strong><small>이 브라우저에 저장됨 · 음악 제외</small>
              </div>
              <div className="template-row">
                <button type="button" onClick={saveTemplate} disabled={templateBusy}>
                  <span>◇</span><strong>{templateBusy ? "처리 중…" : "새 템플릿 저장"}</strong>
                </button>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                  aria-label="저장된 템플릿 선택"
                >
                  <option value="">저장된 템플릿 없음</option>
                  {savedTemplates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>
              <div className="template-actions">
                <button type="button" onClick={loadTemplate} disabled={!selectedTemplateId || templateBusy}>불러오기</button>
                <button type="button" onClick={deleteTemplate} disabled={!selectedTemplateId || templateBusy}>삭제</button>
              </div>
            </div>
          </div>
        </div>

        <div className="preview-column">
          <div className="preview-label"><span>01</span><p>LIVE PREVIEW</p><i /></div>
          <div className={`player-stage ${transparentBackground ? "transparent" : ""}`}>
            <div className="corner-label top-left">A</div>
            <div className="corner-label bottom-right">B</div>
            <div className="player-card">
              <div className="track-row">
                <button
                  className={`cover-button ${cover ? "adjustable" : ""} ${isDragging ? "dragging" : ""}`}
                  type="button"
                  onClick={() => { if (!cover) fileRef.current?.click(); }}
                  onPointerDown={startCoverDrag}
                  onPointerMove={moveCover}
                  onPointerUp={stopCoverDrag}
                  onPointerCancel={stopCoverDrag}
                  onWheel={zoomCover}
                  aria-label="앨범 커버 위치 및 크기 조절"
                  title={cover ? "" : "앨범 커버 바꾸기"}
                >
                  {cover ? (
                    <img
                      src={cover}
                      alt="선택한 앨범 커버"
                      draggable="false"
                      style={{
                        transform: `translate(-50%, -50%) scale(${coverScale})`,
                        transformOrigin: `${coverFocus.x}% ${coverFocus.y}%`,
                      }}
                    />
                  ) : (
                    <span className="cover-placeholder"><b>YOUR</b><b>VIBE</b><i>♥</i></span>
                  )}
                </button>
                <div className="track-copy">
                  <small>{device || "iPhone"}</small>
                  <strong>{title}</strong>
                  <p>{[artist, title].filter(Boolean).join(" — ")}</p>
                </div>
                <div className={`waveform ${isPlaying ? "playing" : ""}`} aria-hidden="true">
                  {waveLevels.map((level, index) => (
                    <i key={index} style={{ height: `${(12 + level * 70) / 9.9}cqw` }} />
                  ))}
                </div>
              </div>

              <div className="timeline">
                <input
                  type="range"
                  min="0"
                  max={duration}
                  value={currentTime}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  aria-label="재생 위치"
                  style={{ "--range-progress": `${(currentTime / Math.max(1, duration)) * 100}%` } as React.CSSProperties}
                />
                <div><span>{formatTime(currentTime)}</span><span>-{formatTime(duration - currentTime)}</span></div>
              </div>

              <div className="controls">
                <button type="button" onClick={() => skip(-10)} aria-label="10초 뒤로"><span className="skip prev" /></button>
                <button className="play" type="button" onClick={togglePlayback} aria-label={isPlaying ? "일시정지" : "재생"}>
                  {isPlaying ? <span className="pause-icon"><i /><i /></span> : <span className="play-icon" />}
                </button>
                <button type="button" onClick={() => skip(10)} aria-label="10초 앞으로"><span className="skip next" /></button>
              </div>

              <div className="volume-row">
                <span className="speaker quiet">◀</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  aria-label="볼륨"
                  style={{ "--range-progress": `${volume}%` } as React.CSSProperties}
                />
                <span className="speaker loud">◀))</span>
              </div>

              <div className="sticker-layer" aria-label="스티커 편집 영역">
                {stickers.map((sticker) => (
                  <div
                    className="sticker-item"
                    key={sticker.id}
                    style={{
                      left: `${sticker.x}%`,
                      top: `${sticker.y}%`,
                      width: `${sticker.size}%`,
                    }}
                    onPointerDown={(event) => startStickerInteraction(event, sticker, "drag")}
                    onPointerMove={moveSticker}
                    onPointerUp={stopStickerInteraction}
                    onPointerCancel={stopStickerInteraction}
                  >
                    <img src={sticker.src} alt="추가한 스티커" draggable="false" />
                    <button
                      className="sticker-delete"
                      type="button"
                      aria-label="스티커 삭제"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setStickers((current) => current.filter((item) => item.id !== sticker.id));
                      }}
                    >
                      ×
                    </button>
                    <button
                      className="sticker-resize"
                      type="button"
                      aria-label="스티커 크기 조절"
                      onPointerDown={(event) => startStickerInteraction(event, sticker, "resize")}
                      onPointerMove={moveSticker}
                      onPointerUp={stopStickerInteraction}
                      onPointerCancel={stopStickerInteraction}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="preview-tip"><span>TIP</span> 스티커는 플레이어 밖 투명 여백까지 이동하고 크기를 조절할 수 있어요.</p>
        </div>
      </section>

      <footer><p>MADE FOR YOUR MOMENTS</p><span>VINYLAB · PLAYER CUSTOMIZER</span></footer>
    </main>
  );
}
