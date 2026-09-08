import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("transcribe");

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_PATH = join(config.workspace, ".models", "ggml-base.bin");

async function ensureTool(bin: string, brewPkg: string) {
  if (Bun.which(bin)) return;
  log.info(`installing ${brewPkg} (missing ${bin})`);
  const proc = Bun.spawn(["brew", "install", brewPkg], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`brew install ${brewPkg} failed`);
}

async function ensureModel() {
  if (await Bun.file(MODEL_PATH).exists()) return;
  log.info("downloading whisper model (~141MB)");
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  await Bun.write(MODEL_PATH, res);
}

/** Transcribes a voice message file (any format ffmpeg reads) to text using local whisper.cpp. */
export async function transcribe(audioPath: string): Promise<string> {
  await Promise.all([ensureTool("ffmpeg", "ffmpeg"), ensureTool("whisper-cli", "whisper-cpp")]);
  await ensureModel();

  const wavPath = `${audioPath}.wav`;
  const conv = Bun.spawn(["ffmpeg", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await conv.exited) !== 0) throw new Error("ffmpeg conversion failed");

  try {
    const proc = Bun.spawn(["whisper-cli", "-m", MODEL_PATH, "-f", wavPath, "-nt", "-np", "-l", "auto"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return text.trim();
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}
