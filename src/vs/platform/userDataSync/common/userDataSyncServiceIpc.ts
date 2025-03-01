/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IChannel, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { ILogService } from 'vs/platform/log/common/log';
import { IUserDataProfilesService, reviveProfile } from 'vs/platform/userDataProfile/common/userDataProfile';
import { IUserDataManualSyncTask, IUserDataSyncResourceConflicts, IUserDataSyncResourceError, IUserDataSyncResource, ISyncResourceHandle, IUserDataSyncTask, IUserDataResourceManifest, IUserDataSyncService, SyncResource, SyncStatus, UserDataSyncError, IUserDataSyncResourcePreview } from 'vs/platform/userDataSync/common/userDataSync';

type ManualSyncTaskEvent<T> = { manualSyncTaskId: string; data: T };

function reviewSyncResource(syncResource: IUserDataSyncResource, userDataProfilesService: IUserDataProfilesService) {
	return { ...syncResource, profie: reviveProfile(syncResource.profile, userDataProfilesService.profilesHome.scheme) };
}

export class UserDataSyncChannel implements IServerChannel {

	private readonly manualSyncTasks = new Map<string, { manualSyncTask: IUserDataManualSyncTask; disposables: DisposableStore }>();
	private readonly onManualSynchronizeResources = new Emitter<ManualSyncTaskEvent<[SyncResource, URI[]][]>>();

	constructor(
		private readonly service: IUserDataSyncService,
		private readonly userDataProfilesService: IUserDataProfilesService,
		private readonly logService: ILogService
	) { }

	listen(_: unknown, event: string): Event<any> {
		switch (event) {
			// sync
			case 'onDidChangeStatus': return this.service.onDidChangeStatus;
			case 'onDidChangeConflicts': return this.service.onDidChangeConflicts;
			case 'onDidChangeLocal': return this.service.onDidChangeLocal;
			case 'onDidChangeLastSyncTime': return this.service.onDidChangeLastSyncTime;
			case 'onSyncErrors': return this.service.onSyncErrors;
			case 'onDidResetLocal': return this.service.onDidResetLocal;
			case 'onDidResetRemote': return this.service.onDidResetRemote;

			// manual sync
			case 'manualSync/onSynchronizeResources': return this.onManualSynchronizeResources.event;
		}

		throw new Error(`Event not found: ${event}`);
	}

	async call(context: any, command: string, args?: any): Promise<any> {
		try {
			const result = await this._call(context, command, args);
			return result;
		} catch (e) {
			this.logService.error(e);
			throw e;
		}
	}

	private async _call(context: any, command: string, args?: any): Promise<any> {
		switch (command) {

			// sync
			case '_getInitialData': return Promise.resolve([this.service.status, this.service.conflicts, this.service.lastSyncTime]);
			case 'reset': return this.service.reset();
			case 'resetRemote': return this.service.resetRemote();
			case 'resetLocal': return this.service.resetLocal();
			case 'hasPreviouslySynced': return this.service.hasPreviouslySynced();
			case 'hasLocalData': return this.service.hasLocalData();
			case 'resolveContent': return this.service.resolveContent(URI.revive(args[0]));
			case 'accept': return this.service.accept(reviewSyncResource(args[0], this.userDataProfilesService), URI.revive(args[1]), args[2], args[3]);
			case 'replace': return this.service.replace(reviewSyncResource(args[0], this.userDataProfilesService), URI.revive(args[1]));
			case 'getLocalSyncResourceHandles': return this.service.getLocalSyncResourceHandles(reviewSyncResource(args[0], this.userDataProfilesService));
			case 'getRemoteSyncResourceHandles': return this.service.getRemoteSyncResourceHandles(reviewSyncResource(args[0], this.userDataProfilesService));
			case 'getAssociatedResources': return this.service.getAssociatedResources(reviewSyncResource(args[0], this.userDataProfilesService), { created: args[1].created, uri: URI.revive(args[1].uri) });
			case 'getMachineId': return this.service.getMachineId(reviewSyncResource(args[0], this.userDataProfilesService), { created: args[1].created, uri: URI.revive(args[1].uri) });

			case 'createManualSyncTask': return this.createManualSyncTask();
		}

		// manual sync
		if (command.startsWith('manualSync/')) {
			const manualSyncTaskCommand = command.substring('manualSync/'.length);
			const manualSyncTaskId = args[0];
			const manualSyncTask = this.getManualSyncTask(manualSyncTaskId);
			args = (<Array<any>>args).slice(1);

			switch (manualSyncTaskCommand) {
				case 'preview': return manualSyncTask.preview();
				case 'accept': return manualSyncTask.accept(URI.revive(args[0]), args[1]);
				case 'merge': return manualSyncTask.merge(URI.revive(args[0]));
				case 'discard': return manualSyncTask.discard(URI.revive(args[0]));
				case 'discardConflicts': return manualSyncTask.discardConflicts();
				case 'apply': return manualSyncTask.apply();
				case 'pull': return manualSyncTask.pull();
				case 'push': return manualSyncTask.push();
				case 'stop': return manualSyncTask.stop();
				case '_getStatus': return manualSyncTask.status;
				case 'dispose': return this.disposeManualSyncTask(manualSyncTask);
			}
		}

		throw new Error('Invalid call');
	}

	private getManualSyncTask(manualSyncTaskId: string): IUserDataManualSyncTask {
		const value = this.manualSyncTasks.get(this.createKey(manualSyncTaskId));
		if (!value) {
			throw new Error(`Manual sync taks not found: ${manualSyncTaskId}`);
		}
		return value.manualSyncTask;
	}

	private async createManualSyncTask(): Promise<{ id: string; manifest: IUserDataResourceManifest | null; status: SyncStatus }> {
		const disposables = new DisposableStore();
		const manualSyncTask = disposables.add(await this.service.createManualSyncTask());
		disposables.add(manualSyncTask.onSynchronizeResources(synchronizeResources => this.onManualSynchronizeResources.fire({ manualSyncTaskId: manualSyncTask.id, data: synchronizeResources })));
		this.manualSyncTasks.set(this.createKey(manualSyncTask.id), { manualSyncTask, disposables });
		return { id: manualSyncTask.id, manifest: manualSyncTask.manifest, status: manualSyncTask.status };
	}

	private disposeManualSyncTask(manualSyncTask: IUserDataManualSyncTask): void {
		manualSyncTask.dispose();
		const key = this.createKey(manualSyncTask.id);
		this.manualSyncTasks.get(key)?.disposables.dispose();
		this.manualSyncTasks.delete(key);
	}

	private createKey(manualSyncTaskId: string): string { return `manualSyncTask-${manualSyncTaskId}`; }

}

export class UserDataSyncChannelClient extends Disposable implements IUserDataSyncService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private _status: SyncStatus = SyncStatus.Uninitialized;
	get status(): SyncStatus { return this._status; }
	private _onDidChangeStatus: Emitter<SyncStatus> = this._register(new Emitter<SyncStatus>());
	readonly onDidChangeStatus: Event<SyncStatus> = this._onDidChangeStatus.event;

	get onDidChangeLocal(): Event<SyncResource> { return this.channel.listen<SyncResource>('onDidChangeLocal'); }

	private _conflicts: IUserDataSyncResourceConflicts[] = [];
	get conflicts(): IUserDataSyncResourceConflicts[] { return this._conflicts; }
	private _onDidChangeConflicts = this._register(new Emitter<IUserDataSyncResourceConflicts[]>());
	readonly onDidChangeConflicts = this._onDidChangeConflicts.event;

	private _lastSyncTime: number | undefined = undefined;
	get lastSyncTime(): number | undefined { return this._lastSyncTime; }
	private _onDidChangeLastSyncTime: Emitter<number> = this._register(new Emitter<number>());
	readonly onDidChangeLastSyncTime: Event<number> = this._onDidChangeLastSyncTime.event;

	private _onSyncErrors = this._register(new Emitter<IUserDataSyncResourceError[]>());
	readonly onSyncErrors = this._onSyncErrors.event;

	get onDidResetLocal(): Event<void> { return this.channel.listen<void>('onDidResetLocal'); }
	get onDidResetRemote(): Event<void> { return this.channel.listen<void>('onDidResetRemote'); }

	constructor(
		userDataSyncChannel: IChannel,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
	) {
		super();
		this.channel = {
			call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
				return userDataSyncChannel.call(command, arg, cancellationToken)
					.then(null, error => { throw UserDataSyncError.toUserDataSyncError(error); });
			},
			listen<T>(event: string, arg?: any): Event<T> {
				return userDataSyncChannel.listen(event, arg);
			}
		};
		this.channel.call<[SyncStatus, IUserDataSyncResourceConflicts[], number | undefined]>('_getInitialData').then(([status, conflicts, lastSyncTime]) => {
			this.updateStatus(status);
			this.updateConflicts(conflicts);
			if (lastSyncTime) {
				this.updateLastSyncTime(lastSyncTime);
			}
			this._register(this.channel.listen<SyncStatus>('onDidChangeStatus')(status => this.updateStatus(status)));
			this._register(this.channel.listen<number>('onDidChangeLastSyncTime')(lastSyncTime => this.updateLastSyncTime(lastSyncTime)));
		});
		this._register(this.channel.listen<IUserDataSyncResourceConflicts[]>('onDidChangeConflicts')(conflicts => this.updateConflicts(conflicts)));
		this._register(this.channel.listen<IUserDataSyncResourceError[]>('onSyncErrors')(errors => this._onSyncErrors.fire(errors.map(syncError => ({ ...syncError, error: UserDataSyncError.toUserDataSyncError(syncError.error) })))));
	}

	createSyncTask(): Promise<IUserDataSyncTask> {
		throw new Error('not supported');
	}

	async createManualSyncTask(): Promise<IUserDataManualSyncTask> {
		const { id, manifest, status } = await this.channel.call<{ id: string; manifest: IUserDataResourceManifest | null; status: SyncStatus }>('createManualSyncTask');
		const that = this;
		const manualSyncTaskChannelClient = new ManualSyncTaskChannelClient(id, manifest, status, {
			async call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
				return that.channel.call<T>(`manualSync/${command}`, [id, ...(Array.isArray(arg) ? arg : [arg])], cancellationToken);
			},
			listen<T>(event: string, arg?: any): Event<T> {
				return Event.map(
					Event.filter(that.channel.listen<{ manualSyncTaskId: string; data: T }>(`manualSync/${event}`, arg), e => !manualSyncTaskChannelClient.isDiposed() && e.manualSyncTaskId === id),
					e => e.data);
			}
		}, this.userDataProfilesService);
		return manualSyncTaskChannelClient;
	}

	replace(profileSyncResource: IUserDataSyncResource, uri: URI): Promise<void> {
		return this.channel.call('replace', [profileSyncResource, uri]);
	}

	reset(): Promise<void> {
		return this.channel.call('reset');
	}

	resetRemote(): Promise<void> {
		return this.channel.call('resetRemote');
	}

	resetLocal(): Promise<void> {
		return this.channel.call('resetLocal');
	}

	hasPreviouslySynced(): Promise<boolean> {
		return this.channel.call('hasPreviouslySynced');
	}

	hasLocalData(): Promise<boolean> {
		return this.channel.call('hasLocalData');
	}

	accept(syncResource: IUserDataSyncResource, resource: URI, content: string | null, apply: boolean): Promise<void> {
		return this.channel.call('accept', [syncResource, resource, content, apply]);
	}

	resolveContent(resource: URI): Promise<string | null> {
		return this.channel.call('resolveContent', [resource]);
	}

	async getLocalSyncResourceHandles(resource: IUserDataSyncResource): Promise<ISyncResourceHandle[]> {
		const handles = await this.channel.call<ISyncResourceHandle[]>('getLocalSyncResourceHandles', [resource]);
		return handles.map(({ created, uri }) => ({ created, uri: URI.revive(uri) }));
	}

	async getRemoteSyncResourceHandles(resource: IUserDataSyncResource): Promise<ISyncResourceHandle[]> {
		const handles = await this.channel.call<ISyncResourceHandle[]>('getRemoteSyncResourceHandles', [resource]);
		return handles.map(({ created, uri }) => ({ created, uri: URI.revive(uri) }));
	}

	async getAssociatedResources(resource: IUserDataSyncResource, syncResourceHandle: ISyncResourceHandle): Promise<{ resource: URI; comparableResource: URI }[]> {
		const result = await this.channel.call<{ resource: URI; comparableResource: URI }[]>('getAssociatedResources', [resource, syncResourceHandle]);
		return result.map(({ resource, comparableResource }) => ({ resource: URI.revive(resource), comparableResource: URI.revive(comparableResource) }));
	}

	async getMachineId(resource: IUserDataSyncResource, syncResourceHandle: ISyncResourceHandle): Promise<string | undefined> {
		return this.channel.call<string | undefined>('getMachineId', [resource, syncResourceHandle]);
	}

	private async updateStatus(status: SyncStatus): Promise<void> {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}

	private async updateConflicts(conflicts: IUserDataSyncResourceConflicts[]): Promise<void> {
		// Revive URIs
		this._conflicts = conflicts.map(syncConflict =>
		({
			syncResource: syncConflict.syncResource,
			profile: reviveProfile(syncConflict.profile, this.userDataProfilesService.profilesHome.scheme),
			conflicts: syncConflict.conflicts.map(r =>
			({
				...r,
				baseResource: URI.revive(r.baseResource),
				localResource: URI.revive(r.localResource),
				remoteResource: URI.revive(r.remoteResource),
				previewResource: URI.revive(r.previewResource),
			}))
		}));
		this._onDidChangeConflicts.fire(this._conflicts);
	}

	private updateLastSyncTime(lastSyncTime: number): void {
		if (this._lastSyncTime !== lastSyncTime) {
			this._lastSyncTime = lastSyncTime;
			this._onDidChangeLastSyncTime.fire(lastSyncTime);
		}
	}
}

class ManualSyncTaskChannelClient extends Disposable implements IUserDataManualSyncTask {

	private readonly channel: IChannel;

	get onSynchronizeResources(): Event<[SyncResource, URI[]][]> { return this.channel.listen<[SyncResource, URI[]][]>('onSynchronizeResources'); }

	private _status: SyncStatus;
	get status(): SyncStatus { return this._status; }

	constructor(
		readonly id: string,
		readonly manifest: IUserDataResourceManifest | null,
		status: SyncStatus,
		manualSyncTaskChannel: IChannel,
		private readonly userDataProfilesService: IUserDataProfilesService,
	) {
		super();
		this._status = status;
		const that = this;
		this.channel = {
			async call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
				try {
					const result = await manualSyncTaskChannel.call<T>(command, arg, cancellationToken);
					if (!that.isDiposed()) {
						that._status = await manualSyncTaskChannel.call<SyncStatus>('_getStatus');
					}
					return result;
				} catch (error) {
					throw UserDataSyncError.toUserDataSyncError(error);
				}
			},
			listen<T>(event: string, arg?: any): Event<T> {
				return manualSyncTaskChannel.listen(event, arg);
			}
		};
	}

	async preview(): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('preview');
		return this.deserializePreviews(previews);
	}

	async accept(resource: URI, content?: string | null): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('accept', [resource, content]);
		return this.deserializePreviews(previews);
	}

	async merge(resource?: URI): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('merge', [resource]);
		return this.deserializePreviews(previews);
	}

	async discard(resource: URI): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('discard', [resource]);
		return this.deserializePreviews(previews);
	}

	async discardConflicts(): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('discardConflicts');
		return this.deserializePreviews(previews);
	}

	async apply(): Promise<IUserDataSyncResourcePreview[]> {
		const previews = await this.channel.call<IUserDataSyncResourcePreview[]>('apply');
		return this.deserializePreviews(previews);
	}

	pull(): Promise<void> {
		return this.channel.call('pull');
	}

	push(): Promise<void> {
		return this.channel.call('push');
	}

	stop(): Promise<void> {
		return this.channel.call('stop');
	}

	private _disposed = false;
	isDiposed() { return this._disposed; }

	override dispose(): void {
		this._disposed = true;
		this.channel.call('dispose');
	}

	private deserializePreviews(previews: IUserDataSyncResourcePreview[]): IUserDataSyncResourcePreview[] {
		return previews.map(({ profile, syncResource, resourcePreviews, isLastSyncFromCurrentMachine }) =>
		({
			profile: reviveProfile(profile, this.userDataProfilesService.profilesHome.scheme),
			syncResource,
			isLastSyncFromCurrentMachine,
			resourcePreviews: resourcePreviews.map(r => ({
				...r,
				baseResource: URI.revive(r.baseResource),
				localResource: URI.revive(r.localResource),
				remoteResource: URI.revive(r.remoteResource),
				previewResource: URI.revive(r.previewResource),
				acceptedResource: URI.revive(r.acceptedResource),
			}))
		}));
	}
}
