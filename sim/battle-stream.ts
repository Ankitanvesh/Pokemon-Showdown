/**
 * Battle Stream
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Supports interacting with a PS battle in Stream format.
 *
 * This format is VERY NOT FINALIZED, please do not use it directly yet.
 *
 * @license MIT
 */

import * as Streams from './../lib/streams';
import {Battle} from './battle';

/**
 * Like string.split(delimiter), but only recognizes the first `limit`
 * delimiters (default 1).
 *
 * `"1 2 3 4".split(" ", 2) => ["1", "2"]`
 *
 * `Chat.splitFirst("1 2 3 4", " ", 1) => ["1", "2 3 4"]`
 *
 * Returns an array of length exactly limit + 1.
 */
function splitFirst(str: string, delimiter: string, limit: number = 1) {
	let splitStr: string[] = [];
	while (splitStr.length < limit) {
		let delimiterIndex = str.indexOf(delimiter);
		if (delimiterIndex >= 0) {
			splitStr.push(str.slice(0, delimiterIndex));
			str = str.slice(delimiterIndex + delimiter.length);
		} else {
			splitStr.push(str);
			str = '';
		}
	}
	splitStr.push(str);
	return splitStr;
}

export class BattleStream extends Streams.ObjectReadWriteStream {
	debug: boolean;
	keepAlive: boolean;
	battle: Battle | null;

	constructor(options: {debug?: boolean, keepAlive?: boolean} = {}) {
		super();
		this.debug = !!options.debug;
		this.keepAlive = !!options.keepAlive;
		this.battle = null;
	}

	_write(message: string) {
		let startTime = Date.now();
		try {
			for (const line of message.split('\n')) {
				if (line.charAt(0) === '>') this._writeLine(line.slice(1));
			}
		} catch (err) {
			if (typeof Monitor === 'undefined') throw err;
			const battle = this.battle;
			Monitor.crashlog(err, 'A battle', {
				message,
				inputLog: battle ? '\n' + battle.inputLog.join('\n') : '',
				log: battle ? '\n' + battle.getDebugLog() : '',
			});

			this.push(`update\n|html|<div class="broadcast-red"><b>The battle crashed</b><br />Don't worry, we're working on fixing it.</div>`);
			if (battle && battle.p1 && battle.p1.currentRequest) {
				this.push(`sideupdate\np1\n|error|[Invalid choice] The battle crashed`);
			}
			if (battle && battle.p2 && battle.p2.currentRequest) {
				this.push(`sideupdate\np2\n|error|[Invalid choice] The battle crashed`);
			}
		}
		if (this.battle) this.battle.sendUpdates();
		let deltaTime = Date.now() - startTime;
		if (deltaTime > 1000) {
			console.log(`[slow battle] ${deltaTime}ms - ${message}`);
		}
	}

	_writeLine(line: string) {
		let [type, message] = splitFirst(line, ' ');
		switch (type) {
		case 'start':
			const options = JSON.parse(message);
			options.send = (t: string, data: any) => {
				if (Array.isArray(data)) data = data.join("\n");
				this.push(`${t}\n${data}`);
				if (type === 'end' && !this.keepAlive) {
					this.push(null);
					this._destroy();
				}
			};
			if (this.debug) options.debug = true;
			this.battle = new Battle(options);
			break;
		case 'player':
			const [slot, optionsText] = splitFirst(message, ' ');
			this.battle!.setPlayer(slot as PlayerSlot, JSON.parse(optionsText));
			break;
		case 'p1':
		case 'p2':
			if (message === 'undo') {
				this.battle!.undoChoice(type);
			} else {
				this.battle!.choose(type, message);
			}
			break;
		case 'forcewin':
		case 'forcetie':
			this.battle!.win(type === 'forcewin' ? message : null);
			break;
		case 'tiebreak':
			this.battle!.tiebreak();
			break;
		case 'eval':
			/* tslint:disable:no-eval */
			let battle = this.battle!;
			let p1 = battle && battle.p1;
			let p2 = battle && battle.p2;
			let p1active = p1 && p1.active[0];
			let p2active = p2 && p2.active[0];
			battle.inputLog.push(line);
			message = message.replace(/\f/g, '\n');
			battle.add('', '>>> ' + message.replace(/\n/g, '\n||'));
			try {
				let result = eval(message);
				if (result && result.then) {
					result.then((unwrappedResult: any) => {
						unwrappedResult = Chat.stringify(unwrappedResult);
						battle.add('', 'Promise -> ' + unwrappedResult);
						battle.sendUpdates();
					}, (error: Error) => {
						battle.add('', '<<< error: ' + error.message);
						battle.sendUpdates();
					});
				} else {
					result = Chat.stringify(result);
					result = result.replace(/\n/g, '\n||');
					battle.add('', '<<< ' + result);
				}
			} catch (e) {
				battle.add('', '<<< error: ' + e.message);
			}
			/* tslint:enable:no-eval */
			break;
		}
	}
	_end() {
		// this is in theory synchronous...
		this.push(null);
		this._destroy();
	}
	_destroy() {
		if (this.battle) {
			this.battle.destroy();
		}
		this.battle = null;
	}
}

/**
 * Splits a BattleStream into omniscient, spectator, p1, and p2
 * streams, for ease of consumption.
 */
export function getPlayerStreams(stream: BattleStream) {
	let omniscient = new Streams.ObjectReadWriteStream({
		write(data: string) {
			stream.write(data);
		},
		end() {
			stream.end();
		},
	});
	let spectator = new Streams.ObjectReadStream({
		read() {},
	});
	let p1 = new Streams.ObjectReadWriteStream({
		write(data: string) {
			stream.write(data.replace(/(^|\n)/g, `$1>p1 `));
		},
	});
	let p2 = new Streams.ObjectReadWriteStream({
		write(data: string) {
			stream.write(data.replace(/(^|\n)/g, `$1>p2 `));
		},
	});
	(async () => {
		let chunk;
		// tslint:disable-next-line:no-conditional-assignment
		while ((chunk = await stream.read())) {
			const [type, data] = splitFirst(chunk, `\n`);
			switch (type) {
			case 'update':
				const p1Update = data.replace(/\n\|split\n[^\n]*\n([^\n]*)\n[^\n]*\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
				p1.push(p1Update);
				const p2Update = data.replace(/\n\|split\n[^\n]*\n[^\n]*\n([^\n]*)\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
				p2.push(p2Update);
				const specUpdate = data.replace(/\n\|split\n([^\n]*)\n[^\n]*\n[^\n]*\n[^\n]*/g, '\n$1').replace(/\n\n/g, '\n');
				spectator.push(specUpdate);
				const omniUpdate = data.replace(/\n\|split\n[^\n]*\n[^\n]*\n[^\n]*/g, '');
				omniscient.push(omniUpdate);
				break;
			case 'sideupdate':
				const [side, sideData] = splitFirst(data, `\n`);
				(side === 'p1' ? p1 : p2).push(sideData);
				break;
			case 'end':
				// ignore
				break;
			}
		}
		omniscient.push(null);
		spectator.push(null);
		p1.push(null);
		p2.push(null);
	})();
	return {omniscient, spectator, p1, p2};
}

export class BattlePlayer {
	// @ts-ignore
	stream: Streams.ObjectReadWriteStream;
	log: string[];
	debug: boolean;

	// @ts-ignore
	constructor(playerStream: Streams.ObjectReadWriteStream, debug: boolean = false) {
		this.stream = playerStream;
		this.log = [];
		this.debug = debug;
		this.listen();
	}
	async listen() {
		let chunk;
		// tslint:disable-next-line:no-conditional-assignment
		while ((chunk = await this.stream.read())) {
			this.receive(chunk);
		}
	}

	receive(chunk: string) {
		for (const line of chunk.split('\n')) {
			this.receiveLine(line);
		}
	}

	receiveLine(line: string) {
		if (this.debug) console.log(line);
		if (line.charAt(0) !== '|') return;
		const [cmd, rest] = splitFirst(line.slice(1), '|');
		if (cmd === 'request') {
			return this.receiveRequest(JSON.parse(rest));
		}
		if (cmd === 'error') {
			throw new Error(rest);
		}
		this.log.push(line);
	}

	receiveRequest(request: AnyObject) {
		throw new Error(`must be implemented by subclass`);
	}

	choose(choice: string) {
		this.stream.write(choice);
	}
}

export class BattleTextStream extends Streams.ReadWriteStream {
	battleStream: BattleStream;
	currentMessage: string;

	constructor(options: {debug?: boolean}) {
		super();
		this.battleStream = new BattleStream(options);
		this.currentMessage = '';
		this._listen();
	}

	_write(message: string | Buffer) {
		this.currentMessage += '' + message;
		let index = this.currentMessage.lastIndexOf('\n');
		if (index >= 0) {
			this.battleStream.write(this.currentMessage.slice(0, index));
			this.currentMessage = this.currentMessage.slice(index + 1);
		}
	}
	_end() {
		this.battleStream.end();
	}
	async _listen() {
		let message: string;
		// tslint:disable-next-line:no-conditional-assignment
		while ((message = await this.battleStream.read())) {
			if (!message.endsWith('\n')) message += '\n';
			this.push(message + '\n');
		}
		this.push(null);
	}
}
