import { join } from "node:path";
import { homedir } from "node:os";
import { unlink, mkdir } from "node:fs/promises";
import { config } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("transcribe");

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_PATH = join(config.workspace, ".models", "ggml-base.bin");
const WHISPER_SRC = join(config.workspace, ".models", "whisper.cpp");
const LOCAL_BIN = join(homedir(), ".local", "bin");

async function run(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", cwd });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function ensureTool(bin: string, brewPkg: string, aptPkg = brewPkg) {
  if (Bun.which(bin)) return;
  log.info(`installing ${bin} (missing)`);
  if (process.platform === "darwin") return run(["brew", "install", brewPkg]);
  await run(["sudo", "apt-get", "update", "-qq"]);
  await run(["sudo", "apt-get", "install", "-y", "-qq", aptPkg]);
}

/** No apt/Ubuntu package for whisper-cli exists reliably, so on Linux it's built from source once. */
async function ensureWhisperCli() {
  if (Bun.which("whisper-cli")) return;
  if (process.platform === "darwin") return run(["brew", "install", "whisper-cpp"]);

  const bin = join(LOCAL_BIN, "whisper-cli");
  if (await Bun.file(bin).exists()) return;
  log.info("building whisper.cpp from source (first run only)");
  if (!(await Bun.file(join(WHISPER_SRC, "CMakeLists.txt")).exists())) {
    await run(["git", "clone", "--depth", "1", "https://github.com/ggml-org/whisper.cpp", WHISPER_SRC]);
  }
  await run(["cmake", "-B", "build"], WHISPER_SRC);
  await run(["cmake", "--build", "build", "-j", "--config", "Release", "--target", "whisper-cli"], WHISPER_SRC);
  await mkdir(LOCAL_BIN, { recursive: true });
  await run(["cp", join(WHISPER_SRC, "build", "bin", "whisper-cli"), bin]);
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
  await Promise.all([ensureTool("ffmpeg", "ffmpeg"), ensureWhisperCli()]);
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
