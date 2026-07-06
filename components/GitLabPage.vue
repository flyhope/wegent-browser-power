<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import { NCard, NSpace, NText } from 'naive-ui';
import AIMix from './include/AIMix.vue';
import PermissionRequest from './include/PermissionRequest.vue';
import type { ToolConfig } from '../services/wegentApi';
import {
  createGitLabApiService,
  parseMergeRequestUrl,
  parseIssueUrl,
  parsePipelineUrl,
  parseTestReportUrl,
  detectGitLabPageType,
  type GitLabPageType,
} from '../services/gitlabApi';
import { getAIMixConfig } from '../services/config';
import type { AIMixActionItem } from '../services/config';

const pageType = ref<GitLabPageType | null>(null);
const currentUrl = ref('');
const currentDomain = ref('');

// AI 操作配置数组（动态加载）
const aiMixActions = ref<AIMixActionItem[]>([]);

// 检测当前 GitLab 页面类型
const detectPage = async () => {
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

    if (activeTab && activeTab.url) {
      currentUrl.value = activeTab.url;
      const detected = detectGitLabPageType(activeTab.url);
      pageType.value = detected?.type ?? null;

      if (pageType.value) {
        const urlObj = new URL(activeTab.url);
        currentDomain.value = urlObj.hostname;
      }
    }
  } catch (error) {
    console.error('Error detecting GitLab page type:', error);
  }
};

// 清理 GitLab URL（剥离 /diffs、/commits、/test_report 等尾部子路径）
const cleanGitLabUrl = (url: string, type: GitLabPageType): string => {
  switch (type) {
    case 'mr':
      return url.replace(/(\/merge_requests\/\d+).*$/, '$1');
    case 'issue':
      return url.replace(/(\/issues\/\d+).*$/, '$1');
    case 'pipeline':
      // pipeline 可能带 /test_report，需保留到 pipeline id
      return url.replace(/(\/pipelines\/\d+).*$/, '$1');
    case 'test_report':
      return url.replace(/(\/pipelines\/\d+\/test_report).*$/, '$1');
  }
};

// 动态获取 code bot 配置（返回携带 workspace 的 wegent_code_bot tool）
// AIAction.vue 的 mergeTools 会先删除 base 中已有的 wegent_code_bot，再追加此处返回的新条目，
// 其余 tools（如 skill、mcp 等）原样保留
const getCodeBotDynamicConfig = async () => {
  if (!pageType.value) {
    throw new Error('未识别到 GitLab 页面类型');
  }

  const gitlabApi = await createGitLabApiService();
  if (!gitlabApi) {
    throw new Error('无法创建 GitLab API 服务，请确保在 GitLab 页面上');
  }

  const type = pageType.value;
  const cleanedUrl = cleanGitLabUrl(currentUrl.value, type);

  if (type === 'mr') {
    const parsed = parseMergeRequestUrl(cleanedUrl);
    if (!parsed) throw new Error('无法解析 Merge Request URL');
    const { projectPath, mrIid } = parsed;
    const mrDetails = await gitlabApi.service.getMergeRequestDetails(projectPath, mrIid);
    return {
      tools: [
        {
          type: 'wegent_code_bot' as const,
          workspace: {
            git_url: mrDetails.sourceProject.http_url_to_repo,
            branch: mrDetails.mergeRequest.source_branch,
            git_repo: mrDetails.sourceProject.path_with_namespace,
          },
        },
      ] as ToolConfig[],
    };
  }

  if (type === 'issue') {
    const parsed = parseIssueUrl(cleanedUrl);
    if (!parsed) throw new Error('无法解析 Issue URL');
    const { projectPath, issueIid } = parsed;
    const issue = await gitlabApi.service.getIssue(projectPath, issueIid);
    const project = await gitlabApi.service.getProject(issue.project_id);
    return {
      tools: [
        {
          type: 'wegent_code_bot' as const,
          workspace: {
            git_url: project.http_url_to_repo,
            branch: project.default_branch || '',
            git_repo: project.path_with_namespace,
          },
        },
      ] as ToolConfig[],
    };
  }

  // pipeline 与 test_report 共用 pipeline.ref 作为 branch
  const pipelineParsed = type === 'test_report'
    ? parseTestReportUrl(cleanedUrl)
    : parsePipelineUrl(cleanedUrl);
  if (!pipelineParsed) {
    throw new Error('无法解析 Pipeline URL');
  }
  const { projectPath, pipelineId } = pipelineParsed;
  const pipeline = await gitlabApi.service.getPipeline(projectPath, pipelineId);
  const project = await gitlabApi.service.getProject(pipeline.project_id);

  return {
    tools: [
      {
        type: 'wegent_code_bot' as const,
        workspace: {
          git_url: project.http_url_to_repo,
          branch: pipeline.ref,
          git_repo: project.path_with_namespace,
        },
      },
    ] as ToolConfig[],
  };
};

// 获取业务数据（返回 map，key 对应 prompt 中的变量名）
const getBusinessData = async (): Promise<Record<string, string>> => {
  if (!pageType.value) {
    return {};
  }

  const type = pageType.value;
  const cleanedUrl = cleanGitLabUrl(currentUrl.value, type);

  if (type === 'mr') {
    const parsed = parseMergeRequestUrl(cleanedUrl);
    if (!parsed) return { mrUrl: cleanedUrl, mrTitle: '' };
    try {
      const gitlabApi = await createGitLabApiService();
      if (!gitlabApi) return { mrUrl: cleanedUrl, mrTitle: '' };
      const mrDetails = await gitlabApi.service.getMergeRequestDetails(parsed.projectPath, parsed.mrIid);
      return {
        mrUrl: cleanedUrl,
        mrTitle: mrDetails.mergeRequest.title || '',
      };
    } catch (error) {
      console.error('获取 MR 详情失败:', error);
      return { mrUrl: cleanedUrl, mrTitle: '' };
    }
  }

  if (type === 'issue') {
    const parsed = parseIssueUrl(cleanedUrl);
    if (!parsed) return { url: cleanedUrl, title: '' };
    try {
      const gitlabApi = await createGitLabApiService();
      if (!gitlabApi) return { url: cleanedUrl, title: '' };
      const issue = await gitlabApi.service.getIssue(parsed.projectPath, parsed.issueIid);
      return {
        url: cleanedUrl,
        title: issue.title || '',
      };
    } catch (error) {
      console.error('获取 Issue 详情失败:', error);
      return { url: cleanedUrl, title: '' };
    }
  }

  // pipeline / test_report 只暴露 {url}
  return { url: cleanedUrl };
};

// 配置键映射
const configKeyMap: Record<GitLabPageType, 'gitLabMR' | 'gitLabTestReport' | 'gitLabIssues' | 'gitLabPipelines'> = {
  mr: 'gitLabMR',
  test_report: 'gitLabTestReport',
  issue: 'gitLabIssues',
  pipeline: 'gitLabPipelines',
};

// 加载 AI Mix 配置并注入动态方法
const loadAIMixConfig = async () => {
  try {
    if (!pageType.value) {
      aiMixActions.value = [];
      return;
    }
    const config = await getAIMixConfig();
    const key = configKeyMap[pageType.value];

    // 所有 GitLab actions 统一注入 getCodeBotDynamicConfig：
    // wegent_code_bot 始终以携带 workspace 的最新版本为准（强制替换已有条目或直接追加），
    // 其他 tools（skill、mcp 等）由 AIAction.vue 的 mergeTools 原样保留
    aiMixActions.value = config[key].actions.map(action => ({
      ...action,
      getAiConfig: getCodeBotDynamicConfig,
    }));
  } catch (error) {
    console.error('加载 AI Mix 配置失败:', error);
    aiMixActions.value = [];
  }
};

onMounted(async () => {
  await detectPage();
  await loadAIMixConfig();
});
</script>

<template>
  <div class="gitlab-container">
    <NCard title="GitLab 集成" :bordered="false" size="large">
      <NSpace vertical :size="20">
        <div v-if="pageType" class="merge-request-section">
          <!-- 权限检查和授权组件 -->
          <PermissionRequest :domain="currentDomain">
            <AIMix :actions="aiMixActions" :get-business-data="getBusinessData" />
          </PermissionRequest>
        </div>

        <NText v-else depth="3">
          当前页面不是受支持的 GitLab 页面
        </NText>
      </NSpace>
    </NCard>
  </div>
</template>
