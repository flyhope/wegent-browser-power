/**
 * 浏览器本地存储配置
 * 统一管理所有存储在 browser.storage.local 中的配置项
 */

import type { ToolConfig } from './wegentApi';
import { encrypt, decrypt, isEncrypted } from './crypto';

/**
 * 扩展配置接口
 * 所有存储在 browser.storage.local 中的配置项的统一结构
 */
export interface ExtensionConfig {
  /** Wegent API 服务地址 */
  wegent_url?: string;
  /** Wegent API 密钥 */
  wegent_api_key?: string;
  /** API 密钥是否已加密（用于兼容旧版数据） */
  wegent_api_key_encrypted?: boolean;
  /** AI Mix 配置订阅 URL，填写后 AI Mix 配置由远程管理，本地不可手动编辑 */
  subscription_url?: string;
}

/**
 * AI Mix AiConfig 接口
 */
export interface AiConfig {
  /** prompt 模板，支持 {content} 占位符 */
  promptTemplate: string;
  /** 模型名称 */
  model?: string;
  /** 工具配置列表 */
  tools?: ToolConfig[];
}

/**
 * AI Mix Action Item 接口
 */
export interface AIMixActionItem {
  /** 操作类型: 'action' - 按钮/提交模式, 'input' - 对话/编码模式 */
  type: 'action' | 'input';
  /** AI 静态配置 */
  aiConfig?: AiConfig;
  /** 按钮标签（仅 type='action' 时生效） */
  buttonLabel?: string;
}

// Re-export types for convenience
export type { ToolConfig };

/**
 * AI Mix 配置接口
 * - `gitLab` 仅作为旧数据回退/旧 UI 兼容读取来源，不再写入新数据
 * - `gitLabMR` 与 `gitLab` 在 `getAIMixConfig` 返回值中保持镜像（`gitLab.actions === gitLabMR.actions`）
 */
export interface AIMixConfig {
  dingTalk: {
    actions: AIMixActionItem[];
  };
  /** 兼容旧数据/旧 UI（值镜像自 gitLabMR） */
  gitLab: {
    actions: AIMixActionItem[];
  };
  gitLabMR: {
    actions: AIMixActionItem[];
  };
  gitLabTestReport: {
    actions: AIMixActionItem[];
  };
  gitLabIssues: {
    actions: AIMixActionItem[];
  };
  gitLabPipelines: {
    actions: AIMixActionItem[];
  };
  jira: {
    actions: AIMixActionItem[];
  };
}

/**
 * AI Mix 存储配置接口（部分可选）
 * - `gitLab` 保留为旧数据回退来源
 */
export interface AIMixStorageConfig {
  dingTalk?: {
    actions?: AIMixActionItem[];
  };
  gitLab?: {
    actions?: AIMixActionItem[];
  };
  gitLabMR?: {
    actions?: AIMixActionItem[];
  };
  gitLabTestReport?: {
    actions?: AIMixActionItem[];
  };
  gitLabIssues?: {
    actions?: AIMixActionItem[];
  };
  gitLabPipelines?: {
    actions?: AIMixActionItem[];
  };
  jira?: {
    actions?: AIMixActionItem[];
  };
}

/**
 * 存储配置的 key 常量
 */
export const STORAGE_KEY = 'extension_config';

/**
 * AI Mix 配置存储 key
 */
export const AI_MIX_CONFIG_KEY = 'ai_mix_config';

/**
 * 挂起的自动配置任务存储 key（存于 storage.session，浏览器关闭后自动清除）
 *
 * 用途：popup 在调用 permissions.request() 前写入任务参数，
 * 若授权弹框导致 popup 关闭，background 通过 permissions.onAdded 读取并接力执行。
 * popup 存活时在 finally 中负责清除，防止 background 重复执行。
 */
export const PENDING_AUTO_CONFIG_KEY = 'pending_auto_config';

/**
 * 挂起的自动配置任务的数据结构
 */
export interface PendingAutoConfig {
  /** wegent 应用根地址，如 https://wegent.xxx.com */
  wegentUrl: string;
  /** 订阅 URL（可选），如 https://xxx.com/subscribe.json；无则为空字符串 */
  subscriptionUrl: string;
  /** 任务创建时间戳（ms），超过有效期后 background 将忽略该任务 */
  timestamp: number;
}

/**
 * 挂起任务的最长有效期（5 分钟）
 * 超出后视为用户已取消授权，background 不再接力执行
 */
export const PENDING_AUTO_CONFIG_EXPIRY_MS = 5 * 60 * 1000;

/**
 * 保存配置到本地存储
 * API 密钥会被加密存储
 * @param config 配置对象
 */
export async function saveConfig(config: Partial<ExtensionConfig>): Promise<void> {
  try {
    // 先获取原始存储数据（不经过解密处理）
    const rawData = await browser.storage.local.get(STORAGE_KEY) as {
      [STORAGE_KEY]?: ExtensionConfig;
    };
    const rawConfig = rawData[STORAGE_KEY] || {};

    // 合并配置
    const merged: ExtensionConfig = { ...rawConfig, ...config };

    // 加密敏感字段（API 密钥）
    if (merged.wegent_api_key) {
      // 如果传入的 api_key 已经是加密状态（来自 getConfig 的解密结果），需要重新加密
      // 如果传入的是明文新值，则需要加密
      merged.wegent_api_key = await encrypt(merged.wegent_api_key);
    }

    // 标记 API 密钥已加密
    merged.wegent_api_key_encrypted = true;

    // 保存
    await browser.storage.local.set({ [STORAGE_KEY]: merged });
  } catch (error) {
    console.error('保存配置失败:', error);
    throw error;
  }
}

/**
 * 从本地存储获取配置
 * API 密钥会被自动解密
 * @returns 配置对象（包含 wegent_api_key_encrypted 标记）
 */
export async function getConfig(): Promise<ExtensionConfig> {
  try {
    const data = await browser.storage.local.get(STORAGE_KEY) as {
      [STORAGE_KEY]?: ExtensionConfig;
    };
    const config = data[STORAGE_KEY] || {};

    // 兼容处理：如果没有加密标记，直接认为未加密（旧版数据）
    if (config.wegent_api_key_encrypted === undefined) {
      config.wegent_api_key_encrypted = false;
    }

    // 解密敏感字段（API 密钥）
    if (config.wegent_api_key && config.wegent_api_key_encrypted) {
      try {
        config.wegent_api_key = await decrypt(config.wegent_api_key);
      } catch (error) {
        console.error('解密 API 密钥失败，可能是数据损坏:', error);
        config.wegent_api_key = undefined;
        config.wegent_api_key_encrypted = false;
      }
    }

    return config;
  } catch (error) {
    console.error('获取配置失败:', error);
    throw error;
  }
}

/**
 * 清除配置中的指定字段
 * @param keys 要清除的字段名数组
 */
export async function clearConfigFields(keys: Array<keyof ExtensionConfig>): Promise<void> {
  try {
    const existing = await getConfig();
    keys.forEach(key => {
      delete existing[key];
    });
    await browser.storage.local.set({ [STORAGE_KEY]: existing });
  } catch (error) {
    console.error('清除配置字段失败:', error);
    throw error;
  }
}

/**
 * 清除所有配置
 */
export async function clearAllConfig(): Promise<void> {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: {} });
  } catch (error) {
    console.error('清除所有配置失败:', error);
    throw error;
  }
}

/**
 * 加载默认 AI Mix 配置（从静态 JSON 文件）
 */
export async function loadDefaultAIMixConfig(): Promise<AIMixConfig> {
  try {
    const response = await fetch('/config/ai-mix-defaults.json');
    if (!response.ok) {
      throw new Error('Failed to load default AI Mix config');
    }
    return response.json();
  } catch (error) {
    console.error('加载默认 AI Mix 配置失败:', error);
    throw error;
  }
}

/**
 * 获取 AI Mix 配置（优先本地存储，无则加载默认配置）
 *
 * 兼容策略：
 * - 读取 MR 配置时优先 `gitLabMR`，回退旧 `gitLab`
 * - 返回值始终包含 `gitLab`（值镜像自 `gitLabMR`），保证 OptionsPage 等旧 UI 不报错
 */
export async function getAIMixConfig(): Promise<AIMixConfig> {
  try {
    // 1. 尝试从本地存储读取
    const data = await browser.storage.local.get(AI_MIX_CONFIG_KEY) as {
      [AI_MIX_CONFIG_KEY]?: AIMixStorageConfig;
    };

    if (data[AI_MIX_CONFIG_KEY]) {
      const stored = data[AI_MIX_CONFIG_KEY]!;
      // 合并确保结构完整（本地存储可能只有部分配置）
      const defaultConfig = await loadDefaultAIMixConfig();

      // MR 优先 gitLabMR，回退旧 gitLab 数据
      const gitLabMRActions = stored.gitLabMR?.actions
        ?? stored.gitLab?.actions
        ?? defaultConfig.gitLabMR.actions;

      return {
        dingTalk: {
          actions: stored.dingTalk?.actions || defaultConfig.dingTalk.actions,
        },
        // 镜像，供旧 UI 读取
        gitLab: {
          actions: gitLabMRActions,
        },
        gitLabMR: {
          actions: gitLabMRActions,
        },
        gitLabTestReport: {
          actions: stored.gitLabTestReport?.actions || defaultConfig.gitLabTestReport.actions,
        },
        gitLabIssues: {
          actions: stored.gitLabIssues?.actions || defaultConfig.gitLabIssues.actions,
        },
        gitLabPipelines: {
          actions: stored.gitLabPipelines?.actions || defaultConfig.gitLabPipelines.actions,
        },
        jira: {
          actions: stored.jira?.actions || defaultConfig.jira.actions,
        },
      };
    }

    // 2. 本地无配置，加载默认 JSON 配置
    return loadDefaultAIMixConfig();
  } catch (error) {
    console.error('获取 AI Mix 配置失败:', error);
    // 失败时尝试加载默认配置
    return loadDefaultAIMixConfig();
  }
}

/**
 * 保存 AI Mix 配置
 */
export async function saveAIMixConfig(config: AIMixStorageConfig): Promise<void> {
  try {
    await browser.storage.local.set({ [AI_MIX_CONFIG_KEY]: config });
  } catch (error) {
    console.error('保存 AI Mix 配置失败:', error);
    throw error;
  }
}

/**
 * 导出完整 AI Mix 配置（当前生效的配置）
 */
export async function exportAIMixConfig(): Promise<AIMixConfig> {
  return getAIMixConfig();
}

/**
 * 导入 AI Mix 配置
 * @param config 导入的配置
 * @param options 导入选项
 *   - `importGitLab`：兼容入口，导入时若仅提供 `gitLab` 则映射到 `gitLabMR`；若同时提供两者以 `gitLabMR` 为准
 *   - `importGitLabMR` / `importGitLabTestReport` / `importGitLabIssues` / `importGitLabPipelines`：分别控制四种 GitLab 类型
 */
export async function importAIMixConfig(
  config: Partial<AIMixConfig>,
  options: {
    importDingTalk?: boolean;
    importGitLab?: boolean;
    importGitLabMR?: boolean;
    importGitLabTestReport?: boolean;
    importGitLabIssues?: boolean;
    importGitLabPipelines?: boolean;
    merge?: boolean;
  } = {}
): Promise<void> {
  const {
    importDingTalk = true,
    importGitLab = true,
    importGitLabMR = true,
    importGitLabTestReport = true,
    importGitLabIssues = true,
    importGitLabPipelines = true,
    merge = true,
  } = options;

  try {
    let newConfig: AIMixStorageConfig = {};

    if (merge) {
      // 合并模式：读取现有配置并合并
      const existing = await browser.storage.local.get(AI_MIX_CONFIG_KEY) as {
        [AI_MIX_CONFIG_KEY]?: AIMixStorageConfig;
      };
      newConfig = existing[AI_MIX_CONFIG_KEY] || {};
    }

    if (importDingTalk && config.dingTalk?.actions) {
      newConfig.dingTalk = {
        actions: config.dingTalk.actions,
      };
    }

    // GitLab MR：优先取 gitLabMR，回退 gitLab（兼容旧导入数据）
    if (importGitLab || importGitLabMR) {
      const mrActions = config.gitLabMR?.actions ?? config.gitLab?.actions;
      if (mrActions) {
        newConfig.gitLabMR = { actions: mrActions };
      }
    }

    if (importGitLabTestReport && config.gitLabTestReport?.actions) {
      newConfig.gitLabTestReport = {
        actions: config.gitLabTestReport.actions,
      };
    }

    if (importGitLabIssues && config.gitLabIssues?.actions) {
      newConfig.gitLabIssues = {
        actions: config.gitLabIssues.actions,
      };
    }

    if (importGitLabPipelines && config.gitLabPipelines?.actions) {
      newConfig.gitLabPipelines = {
        actions: config.gitLabPipelines.actions,
      };
    }

    if (config.jira?.actions) {
      newConfig.jira = {
        actions: config.jira.actions,
      };
    }

    await saveAIMixConfig(newConfig);
  } catch (error) {
    console.error('导入 AI Mix 配置失败:', error);
    throw error;
  }
}

/**
 * 重置 AI Mix 配置（清除本地存储，下次加载将使用默认配置）
 */
export async function resetAIMixConfig(): Promise<void> {
  try {
    await browser.storage.local.remove(AI_MIX_CONFIG_KEY);
  } catch (error) {
    console.error('重置 AI Mix 配置失败:', error);
    throw error;
  }
}

/**
 * 获取订阅 URL
 */
export async function getSubscriptionUrl(): Promise<string> {
  const config = await getConfig();
  return config.subscription_url || '';
}

/**
 * 保存订阅 URL
 */
export async function saveSubscriptionUrl(url: string): Promise<void> {
  try {
    const rawData = await browser.storage.local.get(STORAGE_KEY) as {
      [STORAGE_KEY]?: ExtensionConfig;
    };
    const rawConfig = rawData[STORAGE_KEY] || {};
    await browser.storage.local.set({
      [STORAGE_KEY]: { ...rawConfig, subscription_url: url },
    });
  } catch (error) {
    console.error('保存订阅 URL 失败:', error);
    throw error;
  }
}

/**
 * 将从订阅 URL 获取到的数据写入 AI Mix 配置（完整替换）
 *
 * 写入策略：
 * - 只写四个新键 + dingTalk + jira，不再写 `gitLab`
 * - 订阅源若同时提供 `gitLabMR` 与 `gitLab`，仅以 `gitLabMR` 为准
 * - 若仅提供 `gitLab`（旧订阅源），映射到 `gitLabMR`
 */
export async function applySubscriptionData(data: AIMixConfig): Promise<void> {
  const config: AIMixStorageConfig = {};
  if (data.dingTalk?.actions) config.dingTalk = { actions: data.dingTalk.actions };
  const mrActions = data.gitLabMR?.actions ?? data.gitLab?.actions;
  if (mrActions) config.gitLabMR = { actions: mrActions };
  if (data.gitLabTestReport?.actions) config.gitLabTestReport = { actions: data.gitLabTestReport.actions };
  if (data.gitLabIssues?.actions) config.gitLabIssues = { actions: data.gitLabIssues.actions };
  if (data.gitLabPipelines?.actions) config.gitLabPipelines = { actions: data.gitLabPipelines.actions };
  if (data.jira?.actions) config.jira = { actions: data.jira.actions };
  await saveAIMixConfig(config);
}