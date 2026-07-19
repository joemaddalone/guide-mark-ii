// Cache variables
let systemProfilerHardwareCache: Record<string, string> | null = null;
let chipModelCache: string | null = null;
let machineModelCache: string | null = null;

export interface BenchmarkConditionWarning {
	label: string;
	detail: string;
}

async function runCommand(
	command: string[],
	options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(command, {
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = options?.timeout ?? 5000;
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]).then(
				([stdout, stderr, exitCode]) => ({
					stdout,
					stderr,
					exitCode: exitCode ?? -1,
				}),
			),
			new Promise<never>((_, reject) =>
				setTimeout(() => {
					proc.kill();
					reject(new Error("timeout"));
				}, timeout),
			),
		]);
		return result;
	} catch {
		return { stdout: "", stderr: "", exitCode: -1 };
	}
}

export async function getSystemProfilerHardware(): Promise<
	Record<string, string>
> {
	if (systemProfilerHardwareCache !== null) {
		return systemProfilerHardwareCache;
	}

	const result = await runCommand(["system_profiler", "SPHardwareDataType"]);
	if (result.exitCode !== 0) {
		return {};
	}

	const fields: Record<string, string> = {};
	for (const line of result.stdout.split("\n")) {
		const [key, ...rest] = line.split(":");
		if (rest.length === 0) continue;
		const value = rest.join(":").trim();
		if (key && value) {
			fields[key.trim()] = value;
		}
	}

	if (Object.keys(fields).length > 0) {
		systemProfilerHardwareCache = fields;
	}
	return fields;
}

export async function getChipModel(): Promise<string> {
	if (chipModelCache !== null) {
		return chipModelCache;
	}

	const result = await runCommand(["sysctl", "-n", "machdep.cpu.brand_string"]);
	const chip = result.stdout.trim();
	if (result.exitCode === 0 && chip) {
		chipModelCache = chip;
		return chip;
	}

	const profiler = await getSystemProfilerHardware();
	const profilerChip = profiler.Chip;
	if (profilerChip) {
		chipModelCache = profilerChip;
		return profilerChip;
	}

	return "unknown";
}

export async function getMachineModel(): Promise<string> {
	if (machineModelCache !== null) {
		return machineModelCache;
	}

	const result = await runCommand(["sysctl", "-n", "hw.model"]);
	const model = result.stdout.trim();
	if (result.exitCode === 0 && model) {
		machineModelCache = model;
		return model;
	}

	const profiler = await getSystemProfilerHardware();
	const profilerModel = profiler["Model Identifier"];
	if (profilerModel) {
		machineModelCache = profilerModel;
		return profilerModel;
	}

	return "unknown";
}

export function clearHardwareDetectionCaches(): void {
	systemProfilerHardwareCache = null;
	chipModelCache = null;
	machineModelCache = null;
}

export async function getMemoryGb(): Promise<number> {
	const result = await runCommand(["sysctl", "-n", "hw.memsize"]);
	if (result.exitCode === 0 && result.stdout.trim()) {
		const bytes = parseInt(result.stdout.trim(), 10);
		if (!Number.isNaN(bytes)) {
			return Math.round((bytes / 1024 ** 3) * 10) / 10;
		}
	}
	// Fallback: try to parse from system_profiler
	const profiler = await getSystemProfilerHardware();
	const memoryStr = profiler.Memory;
	if (memoryStr) {
		const match = memoryStr.match(/([\d.]+)\s*GB/i);
		if (match?.[1]) {
			return parseFloat(match[1]);
		}
	}
	return 0;
}

export function getMacOsVersion(): string {
	// Bun doesn't have platform.mac_ver() directly
	// Use process.version for Node.js compat or run sw_vers
	const version = process.env.MACOS_VERSION;
	if (version) return version;

	// Synchronous fallback for simple cases
	try {
		const proc = Bun.spawnSync(["sw_vers", "-productVersion"]);
		if (proc.exitCode === 0) {
			return proc.stdout.toString().trim();
		}
	} catch {
		// ignore
	}
	return "unknown";
}

export async function getPythonVersion(): Promise<string> {
	try {
		const result = await runCommand(["python3", "--version"], {
			timeout: 5000,
		});
		if (result.exitCode === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// ignore
	}
	return "unknown";
}

export function getArchitecture(): string {
	return process.arch || "unknown";
}

export async function getThermalStateFromFoundation(): Promise<string | null> {
	try {
		const result = await runCommand(
			[
				"swift",
				"-e",
				"import Foundation\nlet state = ProcessInfo.processInfo.thermalState\nprint(state.rawValue)",
			],
			{ timeout: 5000 },
		);
		if (result.exitCode === 0 && result.stdout.trim()) {
			const state = parseInt(result.stdout.trim(), 10);
			const states: Record<number, string> = {
				0: "nominal",
				1: "fair",
				2: "serious",
				3: "critical",
			};
			return states[state] ?? `unavailable_foundation_unknown_state_${state}`;
		}
	} catch {
		// ignore
	}
	return null;
}

export async function getThermalState(): Promise<string> {
	const foundationState = await getThermalStateFromFoundation();
	if (foundationState !== null) {
		return foundationState;
	}

	// Check if we're root
	const euid = process.getuid?.() ?? -1;
	if (euid !== 0) {
		return "unavailable_permission";
	}

	try {
		const result = await runCommand(
			["powermetrics", "-n", "1", "-i", "100", "-s", "thermal"],
			{ timeout: 5000 },
		);
		for (const line of result.stdout.split("\n")) {
			if (line.toLowerCase().includes("pressure level")) {
				return (
					line.split(":").pop()?.trim().toLowerCase() ??
					"unavailable_parse_error"
				);
			}
		}
		return "unavailable_parse_error";
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "timeout") {
				return "unavailable_timeout";
			}
			if (error.message.includes("ENOENT")) {
				return "unavailable_powermetrics_not_found";
			}
		}
		return "unavailable_error";
	}
}

export async function getPowerSource(): Promise<string> {
	try {
		const result = await runCommand(["pmset", "-g", "batt"], { timeout: 3000 });
		const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
		if (output.includes("battery power")) {
			return "battery";
		}
		if (output.includes("ac power")) {
			return "ac_power";
		}
		return "unavailable_parse_error";
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "timeout") {
				return "unavailable_timeout";
			}
			if (error.message.includes("ENOENT")) {
				return "unavailable_pmset_not_found";
			}
		}
		return "unavailable_error";
	}
}

export async function getLowPowerMode(): Promise<string> {
	try {
		const result = await runCommand(["pmset", "-g"], { timeout: 3000 });
		const output = `${result.stdout}\n${result.stderr}`;
		for (const line of output.split("\n")) {
			const parts = line.trim().toLowerCase().split(/\s+/);
			if (parts.length >= 2 && parts[0] === "lowpowermode") {
				const value = parts[parts.length - 1];
				if (value === "1") return "on";
				if (value === "0") return "off";
				return "unavailable_parse_error";
			}
		}
		return "unavailable_parse_error";
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "timeout") {
				return "unavailable_timeout";
			}
			if (error.message.includes("ENOENT")) {
				return "unavailable_pmset_not_found";
			}
		}
		return "unavailable_error";
	}
}

function resolveConditionField(
	explicitValue: string | null | undefined,
	hardware: Record<string, unknown>,
	key: string,
	fallbackFn: () => Promise<string>,
): Promise<string> {
	if (explicitValue !== undefined && explicitValue !== null) {
		return Promise.resolve(explicitValue);
	}
	const hardwareValue = hardware[key];
	if (hardwareValue !== undefined && hardwareValue !== null) {
		return Promise.resolve(String(hardwareValue));
	}
	return fallbackFn();
}

export async function getBenchmarkConditionWarnings(
	hardware: Record<string, unknown>,
	powerSource?: string | null,
	lowPowerMode?: string | null,
): Promise<BenchmarkConditionWarning[]> {
	const warnings: BenchmarkConditionWarning[] = [];
	const thermalState = String(hardware.thermal_state ?? "unavailable_unknown");

	if (thermalState.startsWith("unavailable")) {
		warnings.push({
			label: "thermal state unavailable",
			detail: `thermal_state=${thermalState}; mlx-chronos could not read macOS thermal pressure through the available local probes. The run can continue, but thermal context is missing.`,
		});
	} else if (thermalState !== "nominal") {
		warnings.push({
			label: "thermal state",
			detail: `thermal_state=${thermalState}; thermal pressure can reduce performance and make results less comparable.`,
		});
	}

	const resolvedPowerSource = await resolveConditionField(
		powerSource,
		hardware,
		"power_source",
		getPowerSource,
	);
	if (resolvedPowerSource === "battery") {
		warnings.push({
			label: "power source",
			detail:
				"running on battery power can reduce performance; use AC power for comparable runs.",
		});
	}

	const resolvedLowPowerMode = await resolveConditionField(
		lowPowerMode,
		hardware,
		"low_power_mode",
		getLowPowerMode,
	);
	if (resolvedLowPowerMode === "on") {
		warnings.push({
			label: "low power mode",
			detail:
				"Low Power Mode is enabled; disable it for comparable benchmark runs.",
		});
	}

	return warnings;
}

export interface HardwareInfo {
	chip: string;
	machine_model: string;
	memory_gb: number;
	macos_version: string;
	python_version: string;
	architecture: string;
	thermal_state: string;
	power_source: string;
	low_power_mode: string;
}

export async function detectHardware(): Promise<HardwareInfo> {
	const [
		chip,
		machineModel,
		memoryGb,
		macosVersion,
		pythonVersion,
		thermalState,
		powerSource,
		lowPowerMode,
	] = await Promise.all([
		getChipModel(),
		getMachineModel(),
		getMemoryGb(),
		Promise.resolve(getMacOsVersion()),
		getPythonVersion(),
		getThermalState(),
		getPowerSource(),
		getLowPowerMode(),
	]);

	return {
		chip,
		machine_model: machineModel,
		memory_gb: memoryGb,
		macos_version: macosVersion,
		python_version: pythonVersion,
		architecture: getArchitecture(),
		thermal_state: thermalState,
		power_source: powerSource,
		low_power_mode: lowPowerMode,
	};
}
