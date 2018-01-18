import { GDBDebugSession } from './gdb';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles, Event } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { OpenOCD } from './backend/openocd';
import { MI2 } from "./backend/mi2/mi2";
import * as portastic from 'portastic';
import * as tmp from 'tmp';
import * as os from 'os';
import { AdapterOutputEvent, SWOConfigureEvent } from './common';
import { clearTimeout } from 'timers';
import { TelemetryEvent } from './common';

interface ConfigurationArguments extends DebugProtocol.LaunchRequestArguments {
	debugger_args: string[];
	executable: string;
	svdFile: string;
	configFiles: string[];
	swoConfig: any;
	graphConfig: any;
	gdbpath: string;
	openOCDPath: string;
	cwd: string;
	showDevDebugOutput: boolean;
	extensionPath: string;
}

class OpenOCDGDBDebugSession extends GDBDebugSession {
	protected openocd : OpenOCD;
	private args: ConfigurationArguments;
	private gdbPort: number;
	private swoPath: string;
	private device: string;

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: ConfigurationArguments): void {
		args.swoConfig = args.swoConfig || { enabled: false, cpuFrequency: 0, swoFrequency: 0 };
		args.graphConfig = args.graphConfig || [];
		this.args = args;

		this.processLaunchAttachRequest(response, args, false);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: ConfigurationArguments): void {
		args.swoConfig = args.swoConfig || { enabled: false, cpuFrequency: 0, swoFrequency: 0 };
		args.graphConfig = args.graphConfig || [];
		this.args = args;

		this.processLaunchAttachRequest(response, args, true);
	}

	private processLaunchAttachRequest(response: DebugProtocol.AttachResponse, args: ConfigurationArguments, attach: boolean) {
		this.quit = false;
		this.attached = false;
		this.started = false;
		this.crashed = false;
		this.debugReady = false;

		portastic.find({ min: 50000, max: 52000, retrieve: 1 }).then(ports => {
			this.gdbPort = ports[0];
			
			this.swoPath = tmp.tmpNameSync();

			let defaultExecutable = 'openocd';
			let defaultGDBExecutable = 'arm-none-eabi-gdb';
			if(os.platform() === 'win32') {
				defaultExecutable = 'openocd.exe';
				defaultGDBExecutable = 'arm-none-eabi-gdb.exe';
			}

			this.openocd = new OpenOCD(args.openOCDPath || defaultExecutable, args.configFiles, this.gdbPort, {
				enabled: args.swoConfig.enabled,
				cpuFrequency: args.swoConfig.cpuFrequency,
				swoFrequency: args.swoConfig.swoFrequency,
				swoFIFOPath: this.swoPath
			});
			this.openocd.on('openocd-output', this.handleAdapterOutput.bind(this));
			this.openocd.on('openocd-stderr', this.handleAdapterErrorOutput.bind(this));
			this.openocd.on("launcherror", (error) => {
				this.sendErrorResponse(response, 103, `Failed to launch OpenOCD Server: ${error.toString()}`);
			});
			this.openocd.on("quit", () => {
				if (this.started) {
					this.quitEvent.bind(this)
				}
				else {
					this.sendErrorResponse(response, 103, `OpenOCD GDB Server Quit Unexpectedly. See Adapter Output for more details.`);
					this.sendErrorResponse(response, 103, `OpenOCD GDB Server Quit Unexpectedly.`);
				}
			});
			
			let timeout = null;

			this.openocd.on('openocd-init', (cpu: string) => {
				console.log('Open OCD Initialized with CPU: ', cpu);
				this.device = cpu.trim();

				if(timeout) {
					clearTimeout(timeout);
					timeout = null;
				}

				this.miDebugger = new MI2(args.gdbpath || defaultGDBExecutable, ["-q", "--interpreter=mi2"], args.debugger_args);
				this.initDebugger();
	
				this.miDebugger.printCalls = !!args.showDevDebugOutput;
				this.miDebugger.debugOutput = !!args.showDevDebugOutput

				let commands = attach ? this.attachCommands(this.gdbPort, args) : this.launchCommands(this.gdbPort, args);
				
				this.miDebugger.connect(args.cwd, args.executable, commands).then(() => {
					setTimeout(() => {
						this.miDebugger.emit("ui-break-done");
					}, 50);
	
					this.miDebugger.start().then(() => {
						this.started = true;
						this.sendResponse(response);
						if (this.crashed)
							this.handlePause(undefined);
					}, err => {
						this.sendErrorResponse(response, 100, `Failed to launch GDB: ${err.toString()}`);
						this.sendEvent(new TelemetryEvent('error-launching-gdb', { error: err.toString() }, {}));
					});
				}, err => {
					this.sendErrorResponse(response, 103, `Failed to launch GDB: ${err.toString()}`);
					this.sendEvent(new TelemetryEvent('error-launching-gdb', { error: err.toString() }, {}));
				});
			})

			this.openocd.init().then(_ => {
				if(args.swoConfig.enabled) {
					this.sendEvent(new SWOConfigureEvent('openocd', { path: this.swoPath }));
				}
			}, err => {
				this.sendErrorResponse(response, 103, `Failed to launch OpenOCD Server: ${err.toString()}`);
				this.sendEvent(new TelemetryEvent('error-launching-openocd', { error: err.toString() }, {}));
			});

			timeout = setTimeout(() => {
				this.openocd.exit();
				this.sendErrorResponse(response, 103, `Failed to launch OpenOCD Server. Timeout.`);
				this.sendEvent(new TelemetryEvent('error-launching-openocd', { error: `Failed to launch OpenOCD Server. Timeout.` }, {}));
			}, 10000); // Timeout Launching

		}, err => {
			this.sendErrorResponse(response, 103, `Failed to launch OpenOCD Server: ${err.toString()}`);
			this.sendEvent(new TelemetryEvent('error-launching-openocd', { error: err.toString() }, {}));
		});
	}

	protected launchCommands(gdbport: number, args: ConfigurationArguments): string[] {
		let commands = [
			`target-select extended-remote localhost:${gdbport}`,
			'interpreter-exec console "monitor reset halt"',
			'target-download',
			'interpreter-exec console "monitor reset halt"',
			'enable-pretty-printing'
		];

		return commands;
	}

	protected attachCommands(gdbport: number, args: ConfigurationArguments): string[] {
		let commands = [
			`target-select extended-remote localhost:${gdbport}`,
			'interpreter-exec console "monitor halt"',
			'enable-pretty-printing'
		];

		return commands;
	}

	protected restartCommands(): string[] {
		return [
			'exec-interrupt',
			'interpreter-exec console "monitor reset halt"',
			'exec-step-instruction'
		];
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		if(this.miDebugger) {
			if (this.attached)
				this.miDebugger.detach();
			else
				this.miDebugger.stop();
		}
		if(this.commandServer) {
			this.commandServer.close();
			this.commandServer = undefined;
		}

		try { this.openocd.stop(); }
		catch(e) {}

		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
		this.miDebugger.restart(this.restartCommands()).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 6, `Could not restart: ${msg}`);
		})
	}

	protected handleAdapterOutput(output) {
		this.sendEvent(new AdapterOutputEvent(output, 'out'));
	}

	protected handleAdapterErrorOutput(output) {
		this.sendEvent(new AdapterOutputEvent(output, 'err'));
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
		switch(command) {
			case 'get-arguments':
				response.body = {
					type: 'openocd',
					GDBPort: this.gdbPort,
					SWOPath: this.swoPath,
					...this.args
				};
				this.sendResponse(response);
				break;
			default:
				super.customRequest(command, response, args);
				break;
		}
	}

	private calculatePortMask(configuration: any[]) {
		let mask: number = 0;
		configuration.forEach(c => {
			mask = (mask | (1 << c.number)) >>> 0;
		});
		return mask;
	}
}

DebugSession.run(OpenOCDGDBDebugSession);