import path from "node:path";
import { isSupportedNodeVersion } from "./platform-support.mjs";

export class SetupRequirementsError extends Error {
  constructor(problems) {
    super([
      "Windows setup cannot continue:",
      ...problems.map((problem) => `- ${problem}`),
      "This setup does not install prerequisites. Install or expose them through PATH, then run it again."
    ].join("\n"));
    this.name = "SetupRequirementsError";
  }
}

export function windowsChromeCandidates(env) {
  return [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    env.PROGRAMFILES && path.win32.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && path.win32.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
}

export async function checkWindowsRequirements({
  platform,
  nodeVersion,
  env,
  commandAvailable,
  fileExists
}) {
  const problems = [];
  if (platform !== "win32") problems.push("This guided setup supports Windows 10/11 only.");
  if (!isSupportedNodeVersion(nodeVersion)) {
    problems.push("Node.js 22.22.2, 24.15.0, or 26.0.0+ is required through PATH.");
  }
  if (!await commandAvailable("npm", ["--version"])) {
    problems.push("npm is required through PATH and must start successfully.");
  }
  if (!await commandAvailable("opencode", ["--version"])) {
    problems.push("The OpenCode CLI is required through PATH and must start successfully.");
  }

  let chromePath;
  for (const candidate of windowsChromeCandidates(env)) {
    if (await fileExists(candidate)) {
      chromePath = candidate;
      break;
    }
  }
  if (!chromePath) {
    problems.push("Google Chrome stable is required in a standard installation location.");
  }
  if (problems.length > 0) throw new SetupRequirementsError(problems);
  return { chromePath };
}

export async function runWindowsSetup({
  platform,
  nodeVersion,
  env,
  repoRoot,
  commandAvailable,
  fileExists,
  run,
  open,
  log
}) {
  const completedStages = [];
  let chromePath;
  const stages = [
    {
      id: "requirements",
      label: "Checking requirements",
      action: async () => {
        ({ chromePath } = await checkWindowsRequirements({
          platform,
          nodeVersion,
          env,
          commandAvailable,
          fileExists
        }));
      }
    },
    {
      id: "dependencies",
      label: "Installing project dependencies",
      action: () => run("npm", ["ci"], { cwd: repoRoot })
    },
    {
      id: "native-host",
      label: "Registering the Chrome bridge",
      action: () => run("npm", ["run", "install:native"], { cwd: repoRoot })
    },
    {
      id: "opencode-plugin",
      label: "Installing the OpenCode plugin",
      action: () => run("npm", ["run", "install:opencode"], { cwd: repoRoot })
    },
    {
      id: "verification",
      label: "Verifying the installation",
      action: () => run("npm", ["run", "verify"], { cwd: repoRoot })
    },
    {
      id: "chrome",
      label: "Opening Chrome for the final manual step",
      action: async () => {
        await open(chromePath, ["chrome://extensions"]);
        await open("explorer.exe", [path.win32.join(repoRoot, "extension")]);
      }
    }
  ];

  for (const stage of stages) {
    await executeStage({ ...stage, completedStages, log, totalStages: stages.length });
  }
  log("Enable Developer mode, choose Load unpacked, select the opened extension folder, then restart OpenCode.");
  return { chromePath, completedStages };
}

async function executeStage({ id, label, action, completedStages, log, totalStages }) {
  log(`[${completedStages.length + 1}/${totalStages}] ${label}...`);
  try {
    await action();
    completedStages.push(id);
    log(`OK: ${label}`);
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(
      `${label} failed: ${detail}\nAdministrator privileges are not required. Correct the problem and run setup-windows.cmd again.`,
      { cause: error }
    );
  }
}
