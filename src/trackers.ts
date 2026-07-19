import { execSync } from "node:child_process";
import os from "node:os";
import { DEFAULT_RAM_SAMPLE_INTERVAL, THERMAL_STATE_ORDER } from "./constants";

const DEFAULT_CHILD_PROCESS_REFRESH_INTERVAL = 30.0;

function isNonNominalThermalState(state: string): boolean {
	return !state.startsWith("unavailable") && state !== "nominal";
}

export class RAMTracker {
	private pid: number;
	private interval: number;
	private childRefreshInterval: number | null;
	private childProcesses: number[] = [];
	private childrenRefreshed = false;
	private lastChildRefreshAt = 0;
	private peakRamBytes = 0;
	private sampleCount = 0;
	private sampleErrors = 0;
	private stopped = false;
	private monitorPromise: Promise<void> | null = null;

	constructor(
		interval: number = DEFAULT_RAM_SAMPLE_INTERVAL,
		targetPid?: number,
		childRefreshInterval:
			| number
			| null = DEFAULT_CHILD_PROCESS_REFRESH_INTERVAL,
	) {
		this.pid = targetPid ?? process.pid;
		this.interval = interval;
		if (childRefreshInterval !== null && childRefreshInterval <= 0) {
			throw new Error("child_refresh_interval must be greater than 0 when set");
		}
		this.childRefreshInterval = childRefreshInterval;
	}

	private async refreshChildProcesses(): Promise<void> {
		try {
			const proc = Bun.spawn(["pgrep", "-P", String(this.pid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await proc.stdout.text();
			this.childProcesses = output
				.split("\n")
				.filter(Boolean)
				.map((line) => parseInt(line.trim(), 10))
				.filter((pid) => !Number.isNaN(pid));
		} catch {
			this.childProcesses = [];
		}
		this.childrenRefreshed = true;
		this.lastChildRefreshAt = performance.now() / 1000;
	}

	private shouldRefreshChildProcesses(): boolean {
		if (!this.childrenRefreshed) return true;
		if (this.childRefreshInterval === null) return false;
		return (
			performance.now() / 1000 - this.lastChildRefreshAt >=
			this.childRefreshInterval
		);
	}

	private async sampleRss(): Promise<number> {
		let rssBytes = 0;

		// Get main process RSS
		try {
			const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(this.pid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await proc.stdout.text();
			const rss = parseInt(output.trim(), 10);
			if (!Number.isNaN(rss)) {
				rssBytes = rss * 1024; // ps returns KB
			}
		} catch {
			// ignore
		}

		// Get child process RSS
		if (this.shouldRefreshChildProcesses()) {
			await this.refreshChildProcesses();
		}

		for (const childPid of this.childProcesses) {
			try {
				const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(childPid)], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await proc.stdout.text();
				const rss = parseInt(output.trim(), 10);
				if (!Number.isNaN(rss)) {
					rssBytes += rss * 1024;
				}
			} catch {
				// ignore
			}
		}

		this.sampleCount++;
		return rssBytes;
	}

	private monitor = async (): Promise<void> => {
		while (!this.stopped) {
			try {
				const currentRam = await this.sampleRss();
				if (currentRam > this.peakRamBytes) {
					this.peakRamBytes = currentRam;
				}
			} catch {
				this.sampleErrors++;
				// Check if process is still running
				try {
					const proc = Bun.spawn(["ps", "-p", String(this.pid)], {
						stdout: "pipe",
						stderr: "pipe",
					});
					const output = await proc.stdout.text();
					if (!output.includes(String(this.pid))) {
						break;
					}
				} catch {
					break;
				}
			}

			await new Promise((resolve) => setTimeout(resolve, this.interval * 1000));
		}
	};

	async start(): Promise<void> {
		await this.refreshChildProcesses();
		this.peakRamBytes = await this.sampleRss();
		this.stopped = false;
		this.monitorPromise = this.monitor();
	}

	async stop(): Promise<number> {
		this.stopped = true;
		if (this.monitorPromise) {
			await this.monitorPromise;
			this.monitorPromise = null;
		}
		return this.peakRamBytes / 1024 ** 3;
	}

	getStats(): {
		peakRamBytes: number;
		sampleCount: number;
		sampleErrors: number;
	} {
		return {
			peakRamBytes: this.peakRamBytes,
			sampleCount: this.sampleCount,
			sampleErrors: this.sampleErrors,
		};
	}
}

export class SystemRAMTracker {
	private interval: number;
	private peakUsedBytes = 0;
	private peakPercent = 0;
	private sampleCount = 0;
	private sampleErrors = 0;
	private stopped = false;
	private monitorPromise: Promise<void> | null = null;

	constructor(interval: number = DEFAULT_RAM_SAMPLE_INTERVAL) {
		this.interval = interval;
	}

	private async sampleSystemRAM(): Promise<[number, number]> {
		try {
			// Use os.totalmem() - os.freemem() which matches Python's total - available
			const totalBytes = os.totalmem();
			const freeBytes = os.freemem();
			const usedBytes = totalBytes - freeBytes;
			const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
			return [usedBytes, percent];
		} catch {
			return [0, 0];
		}
	}

	private async recordSample(): Promise<void> {
		const [usedBytes, percent] = await this.sampleSystemRAM();
		this.sampleCount++;
		if (usedBytes > this.peakUsedBytes) {
			this.peakUsedBytes = usedBytes;
			this.peakPercent = percent;
		}
	}

	private monitor = async (): Promise<void> => {
		while (!this.stopped) {
			try {
				await this.recordSample();
			} catch {
				this.sampleErrors++;
			}
			await new Promise((resolve) => setTimeout(resolve, this.interval * 1000));
		}
	};

	async start(): Promise<void> {
		try {
			await this.recordSample();
		} catch {
			this.sampleErrors++;
		}
		this.stopped = false;
		this.monitorPromise = this.monitor();
	}

	async stop(): Promise<[number, number]> {
		this.stopped = true;
		if (this.monitorPromise) {
			await this.monitorPromise;
			this.monitorPromise = null;
		}
		if (this.sampleCount === 0) {
			throw new Error("system RAM monitor collected no valid samples");
		}
		return [this.peakUsedBytes / 1024 ** 3, this.peakPercent];
	}

	getStats(): {
		peakUsedBytes: number;
		peakPercent: number;
		sampleCount: number;
		sampleErrors: number;
	} {
		return {
			peakUsedBytes: this.peakUsedBytes,
			peakPercent: this.peakPercent,
			sampleCount: this.sampleCount,
			sampleErrors: this.sampleErrors,
		};
	}
}

export class ThermalStateTracker {
	private interval: number;
	private sampler: () => Promise<string> | string;
	private phase = "setup";
	private samples: Array<[string, string]> = [];
	private sampleErrors = 0;
	private stopped = false;
	private monitorPromise: Promise<void> | null = null;

	constructor(
		interval: number = 1.0,
		sampler?: () => Promise<string> | string,
	) {
		this.interval = interval;
		this.sampler = sampler ?? this.defaultFoundationSampler;
	}

	private defaultFoundationSampler = async (): Promise<string> => {
		try {
			const result = execSync(
				"defaults read /Library/Preferences/SystemConfiguration/.GlobalPreferences.plist _thermalState",
				{ timeout: 5000, encoding: "utf-8" },
			).trim();
			const state = parseInt(result, 10);
			const states: Record<number, string> = {
				0: "nominal",
				1: "fair",
				2: "serious",
				3: "critical",
			};
			return states[state] ?? "unavailable_foundation";
		} catch {
			return "unavailable_foundation";
		}
	};

	private async sampleThermalState(): Promise<string> {
		const state = await this.sampler();
		if (typeof state === "string" && state.trim()) {
			return state.trim();
		}
		return "unavailable_foundation";
	}

	private async recordSample(): Promise<void> {
		const state = await this.sampleThermalState();
		this.samples.push([this.phase, state]);
	}

	private monitor = async (): Promise<void> => {
		while (!this.stopped) {
			try {
				await this.recordSample();
			} catch {
				this.sampleErrors++;
			}
			await new Promise((resolve) => setTimeout(resolve, this.interval * 1000));
		}
	};

	setPhase(phase: string): void {
		this.phase = phase;
	}

	async start(): Promise<void> {
		this.samples = [];
		try {
			await this.recordSample();
		} catch {
			this.sampleErrors++;
		}
		this.stopped = false;
		this.monitorPromise = this.monitor();
	}

	async stop(): Promise<{
		sample_interval_seconds: number;
		source: string;
		start_state: string;
		end_state: string;
		worst_state: string;
		samples: number;
		changed_during_run: boolean;
		non_nominal_observed: boolean;
		non_nominal_phases: string[];
		sampling_errors: number;
	}> {
		this.stopped = true;
		if (this.monitorPromise) {
			await this.monitorPromise;
			this.monitorPromise = null;
		}
		try {
			await this.recordSample();
		} catch {
			this.sampleErrors++;
		}

		const samplesCopy = [...this.samples];
		const states = samplesCopy.map(([, state]) => state);

		const startState = states[0] ?? "unavailable_foundation";
		const endState = states[states.length - 1] ?? "unavailable_foundation";

		const observedKnownStates = states.filter(
			(state) => state in THERMAL_STATE_ORDER,
		);

		let worstState: string;
		let source: string;

		if (observedKnownStates.length > 0) {
			worstState = observedKnownStates.reduce((worst, state) => {
				const worstRank = THERMAL_STATE_ORDER[worst] ?? 0;
				const stateRank = THERMAL_STATE_ORDER[state] ?? 0;
				return stateRank > worstRank ? state : worst;
			});
			source = "foundation";
		} else {
			worstState = startState;
			source = "unavailable";
		}

		const nonNominalPhases = [
			...new Set(
				samplesCopy
					.filter(([, state]) => isNonNominalThermalState(state))
					.map(([phase]) => phase),
			),
		].sort() as string[];

		return {
			sample_interval_seconds: this.interval,
			source,
			start_state: startState,
			end_state: endState,
			worst_state: worstState,
			samples: samplesCopy.length,
			changed_during_run: new Set(states).size > 1,
			non_nominal_observed: states.some((state) =>
				isNonNominalThermalState(state),
			),
			non_nominal_phases: nonNominalPhases,
			sampling_errors: this.sampleErrors,
		};
	}
}
