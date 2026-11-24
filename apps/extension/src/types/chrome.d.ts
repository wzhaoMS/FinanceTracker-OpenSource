/**
 * The subset of the Chrome extension APIs this extension uses, declared by
 * hand so the build pulls in no third-party type package. Only what the code
 * calls is declared; anything else is a type error, which doubles as a check
 * that no other browser capability creeps in.
 */
declare namespace chrome {
  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    function getManifest(): { version: string; [key: string]: unknown };
    function sendMessage(message: unknown): Promise<unknown>;
    function openOptionsPage(): Promise<void>;

    interface Tab {
      id?: number;
      windowId?: number;
      incognito?: boolean;
    }

    interface MessageSender {
      id?: string;
      url?: string;
      origin?: string;
      tab?: Tab;
      frameId?: number;
      documentId?: string;
      documentLifecycle?: string;
    }

    interface MessageEvent {
      addListener(
        callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
      ): void;
    }
    const onMessage: MessageEvent;

    interface InstalledDetails {
      reason: string;
      previousVersion?: string;
    }
    const onInstalled: { addListener(callback: (details: InstalledDetails) => void): void };
    const onStartup: { addListener(callback: () => void): void };
  }

  namespace storage {
    type AccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
      setAccessLevel(options: { accessLevel: AccessLevel }): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    const onChanged: {
      addListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
      removeListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string;
      js?: string[];
      matches?: string[];
      excludeMatches?: string[];
      runAt?: 'document_start' | 'document_end' | 'document_idle';
      allFrames?: boolean;
      matchOriginAsFallback?: boolean;
      persistAcrossSessions?: boolean;
      world?: 'ISOLATED' | 'MAIN';
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>;
  }

  namespace permissions {
    interface Permissions {
      origins?: string[];
      permissions?: string[];
    }
    function request(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions): Promise<boolean>;
    function contains(permissions: Permissions): Promise<boolean>;
    function getAll(): Promise<Permissions>;
    const onAdded: { addListener(callback: (permissions: Permissions) => void): void };
    const onRemoved: { addListener(callback: (permissions: Permissions) => void): void };
  }

  namespace tabs {
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }): Promise<unknown>;
    function create(properties: { url: string }): Promise<{ id?: number }>;
    function query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>;
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }
}
