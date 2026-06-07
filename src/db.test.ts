import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createAgentProfile,
  listAgentProfiles,
  getAgentProfileById,
  updateAgentProfile,
  deleteAgentProfile,
  createService,
  listServices,
  deleteService,
  createManagedChannel,
  listManagedChannels,
  createTarget,
  listTargets,
  addConversationMessage,
  getConversationHistory,
  clearConversation,
  createCronJob,
  listCronJobs,
  deleteCronJob,
  attachCronToService,
  listServiceCrons,
  detachCronFromService,
  createInstalledDressing,
  listInstalledDressings,
  getInstalledDressingBySkillId,
  getInstalledDressingByProviderKey,
  getInstalledDressingByChannelType,
  updateInstalledDressingVersion,
  updateInstalledDressingConfig,
  deleteInstalledDressing,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- Agent profiles ---

describe('agent profiles', () => {
  it('creates and retrieves an agent profile', () => {
    createAgentProfile({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });

    const agent = getAgentProfileById('test-agent');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('Test Agent');
    expect(agent!.skills.file_read).toBe(true);
  });

  it('lists all agent profiles', () => {
    createAgentProfile({
      id: 'list-agent',
      name: 'List Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    const profiles = listAgentProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
  });

  it('updates agent profile', () => {
    createAgentProfile({
      id: 'upd-agent',
      name: 'Update Me',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });

    updateAgentProfile('upd-agent', { name: 'Updated Agent', smart_step: 1 });
    const agent = getAgentProfileById('upd-agent');
    expect(agent!.name).toBe('Updated Agent');
    expect(agent!.smart_step).toBe(1);
  });

  it('deletes agent profile and cascades', () => {
    createAgentProfile({
      id: 'del-agent',
      name: 'Delete Me',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    deleteAgentProfile('del-agent');
    expect(getAgentProfileById('del-agent')).toBeUndefined();
  });
});

// --- Services ---

describe('services', () => {
  beforeEach(() => {
    createAgentProfile({
      id: 'svc-agent',
      name: 'Svc Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    createManagedChannel({
      id: 'ch-1',
      type: 'telegram',
      name: 'Test Bot',
      configJson: '{}',
    });
    createTarget({
      id: 'tgt-1',
      targetId: '12345',
      nickname: 'TestUser',
      platform: 'telegram',
    });
  });

  it('creates and lists a service', () => {
    createService({
      id: 'svc-1',
      agentProfileId: 'svc-agent',
      channelId: 'ch-1',
      targetId: 'tgt-1',
    });
    const services = listServices();
    const svc = services.find((s) => s.id === 'svc-1');
    expect(svc).toBeDefined();
    expect(svc!.status).toBe('active');
  });

  it('deletes a service and its conversations', () => {
    createService({
      id: 'svc-del',
      agentProfileId: 'svc-agent',
      channelId: 'ch-1',
      targetId: 'tgt-1',
    });
    addConversationMessage('svc-del', 'user', 'hello');
    deleteService('svc-del');
    expect(listServices().find((s) => s.id === 'svc-del')).toBeUndefined();
  });
});

// --- Conversations ---

describe('conversations', () => {
  it('stores and retrieves conversation messages', () => {
    createAgentProfile({
      id: 'conv-agent',
      name: 'Conv Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    createManagedChannel({
      id: 'ch-conv',
      type: 'telegram',
      name: 'Conv Bot',
      configJson: '{}',
    });
    createTarget({
      id: 'tgt-conv',
      targetId: '99999',
      nickname: 'ConvUser',
      platform: 'telegram',
    });
    createService({
      id: 'svc-conv',
      agentProfileId: 'conv-agent',
      channelId: 'ch-conv',
      targetId: 'tgt-conv',
    });

    addConversationMessage('svc-conv', 'user', 'hello');
    addConversationMessage('svc-conv', 'assistant', 'hi there');

    const history = getConversationHistory('svc-conv');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
  });

  it('clears conversation', () => {
    createAgentProfile({
      id: 'clr-agent',
      name: 'Clr Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    createManagedChannel({
      id: 'ch-clr',
      type: 'telegram',
      name: 'Clr Bot',
      configJson: '{}',
    });
    createTarget({
      id: 'tgt-clr',
      targetId: '88888',
      nickname: 'ClrUser',
      platform: 'telegram',
    });
    createService({
      id: 'svc-clr',
      agentProfileId: 'clr-agent',
      channelId: 'ch-clr',
      targetId: 'tgt-clr',
    });

    addConversationMessage('svc-clr', 'user', 'hello');
    clearConversation('svc-clr');
    expect(getConversationHistory('svc-clr')).toHaveLength(0);
  });
});

// --- Cron jobs ---

describe('cron jobs', () => {
  it('creates and lists cron jobs', () => {
    createCronJob({
      id: 'cron-1',
      name: 'Morning Report',
      prompt: 'Report please',
      scheduleType: 'weekly',
      scheduleTime: '09:00',
      scheduleDays: '0,1,2,3,4,5,6',
    });
    const jobs = listCronJobs();
    expect(jobs.find((j) => j.id === 'cron-1')).toBeDefined();
  });

  it('deletes cron job and its service_crons', () => {
    createAgentProfile({
      id: 'cron-agent',
      name: 'Cron Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    createManagedChannel({
      id: 'ch-cron',
      type: 'telegram',
      name: 'Cron Bot',
      configJson: '{}',
    });
    createTarget({
      id: 'tgt-cron',
      targetId: '77777',
      nickname: 'CronUser',
      platform: 'telegram',
    });
    createService({
      id: 'svc-cron',
      agentProfileId: 'cron-agent',
      channelId: 'ch-cron',
      targetId: 'tgt-cron',
    });

    createCronJob({
      id: 'cron-del',
      name: 'Delete Me',
      prompt: 'test',
      scheduleType: 'weekly',
      scheduleTime: '10:00',
      scheduleDays: '1,3,5',
    });
    attachCronToService('svc-cron', 'cron-del', '2024-01-01T10:00:00.000Z');

    deleteCronJob('cron-del');
    expect(listCronJobs().find((j) => j.id === 'cron-del')).toBeUndefined();
    expect(
      listServiceCrons().find((sc) => sc.cron_id === 'cron-del'),
    ).toBeUndefined();
  });

  it('attaches and detaches cron from service', () => {
    createAgentProfile({
      id: 'att-agent',
      name: 'Att Agent',
      description: '',
      provider_id: 'anthropic',
      model: 'sonnet',
      system_prompt: '',
      skills: {
        file_read: true,
        file_write: true,
        file_list: true,
        file_upload: false,
        web_fetch: true,
        web_browse: false,
        bash: false,
        terminal: false,
        google_gmail: false,
        google_calendar: false,
        google_drive: false,
        cron: false,
      },
    });
    createManagedChannel({
      id: 'ch-att',
      type: 'telegram',
      name: 'Att Bot',
      configJson: '{}',
    });
    createTarget({
      id: 'tgt-att',
      targetId: '66666',
      nickname: 'AttUser',
      platform: 'telegram',
    });
    createService({
      id: 'svc-att',
      agentProfileId: 'att-agent',
      channelId: 'ch-att',
      targetId: 'tgt-att',
    });

    createCronJob({
      id: 'cron-att',
      name: 'Attach Me',
      prompt: 'test',
      scheduleType: 'weekly',
      scheduleTime: '08:00',
      scheduleDays: '0,1,2,3,4,5,6',
    });
    attachCronToService('svc-att', 'cron-att', '2024-01-01T08:00:00.000Z');

    let scs = listServiceCrons();
    expect(
      scs.find(
        (sc) => sc.cron_id === 'cron-att' && sc.service_id === 'svc-att',
      ),
    ).toBeDefined();

    detachCronFromService('svc-att', 'cron-att');
    scs = listServiceCrons();
    expect(
      scs.find(
        (sc) => sc.cron_id === 'cron-att' && sc.service_id === 'svc-att',
      ),
    ).toBeUndefined();
  });
});

// --- Installed Dressings ---

describe('installed dressings', () => {
  it('creates and lists agent dressing', () => {
    createInstalledDressing({
      id: 'drsg-agent-1',
      dressing_type: 'agent',
      dressing_skill_id: 'store-skill-001',
      name: 'Ollama Local',
      version: '1.0.0',
      provider_key: 'ollama',
      channel_type: null,
      folder_name: 'ollama-local',
      config_schema: '{"base_url":"string"}',
      config_json: null,
      installed_by: 'buyer-abc',
    });

    const all = listInstalledDressings();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Ollama Local');
    expect(all[0].dressing_type).toBe('agent');
    expect(all[0].installed_at).toBeDefined();
  });

  it('creates and lists channel dressing', () => {
    createInstalledDressing({
      id: 'drsg-ch-1',
      dressing_type: 'channel',
      dressing_skill_id: 'store-skill-002',
      name: 'KakaoTalk',
      version: '1.0.0',
      provider_key: null,
      channel_type: 'kakaotalk',
      folder_name: 'kakaotalk',
      config_schema: null,
      config_json: null,
      installed_by: 'buyer-xyz',
    });

    const channels = listInstalledDressings('channel');
    expect(channels).toHaveLength(1);
    expect(channels[0].channel_type).toBe('kakaotalk');

    const agents = listInstalledDressings('agent');
    expect(agents).toHaveLength(0);
  });

  it('filters by dressing_type', () => {
    createInstalledDressing({
      id: 'drsg-a',
      dressing_type: 'agent',
      dressing_skill_id: 'sk-a',
      name: 'Agent Plugin',
      version: '1.0.0',
      provider_key: 'custom-llm',
      channel_type: null,
      folder_name: 'custom-llm',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });
    createInstalledDressing({
      id: 'drsg-c',
      dressing_type: 'channel',
      dressing_skill_id: 'sk-c',
      name: 'Channel Plugin',
      version: '2.0.0',
      provider_key: null,
      channel_type: 'line',
      folder_name: 'line',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    expect(listInstalledDressings('agent')).toHaveLength(1);
    expect(listInstalledDressings('channel')).toHaveLength(1);
    expect(listInstalledDressings()).toHaveLength(2);
  });

  it('retrieves by dressing_skill_id', () => {
    createInstalledDressing({
      id: 'drsg-lookup',
      dressing_type: 'agent',
      dressing_skill_id: 'unique-skill-id',
      name: 'Lookup Test',
      version: '3.0.0',
      provider_key: 'test-provider',
      channel_type: null,
      folder_name: 'test-folder',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    const found = getInstalledDressingBySkillId('unique-skill-id');
    expect(found).toBeDefined();
    expect(found!.id).toBe('drsg-lookup');
    expect(found!.version).toBe('3.0.0');

    expect(getInstalledDressingBySkillId('nonexistent')).toBeUndefined();
  });

  it('retrieves by provider_key', () => {
    createInstalledDressing({
      id: 'drsg-prov',
      dressing_type: 'agent',
      dressing_skill_id: 'sk-prov',
      name: 'Provider Plugin',
      version: '1.0.0',
      provider_key: 'my-ollama',
      channel_type: null,
      folder_name: 'my-ollama',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    const found = getInstalledDressingByProviderKey('my-ollama');
    expect(found).toBeDefined();
    expect(found!.provider_key).toBe('my-ollama');

    expect(getInstalledDressingByProviderKey('nonexistent')).toBeUndefined();
  });

  it('retrieves by channel_type', () => {
    createInstalledDressing({
      id: 'drsg-cht',
      dressing_type: 'channel',
      dressing_skill_id: 'sk-cht',
      name: 'WhatsApp',
      version: '1.0.0',
      provider_key: null,
      channel_type: 'whatsapp',
      folder_name: 'whatsapp',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    const found = getInstalledDressingByChannelType('whatsapp');
    expect(found).toBeDefined();
    expect(found!.channel_type).toBe('whatsapp');

    expect(getInstalledDressingByChannelType('nonexistent')).toBeUndefined();
  });

  it('updates version', () => {
    createInstalledDressing({
      id: 'drsg-upd',
      dressing_type: 'agent',
      dressing_skill_id: 'sk-upd',
      name: 'Update Me',
      version: '1.0.0',
      provider_key: 'upd-key',
      channel_type: null,
      folder_name: 'upd-folder',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    updateInstalledDressingVersion('drsg-upd', '2.0.0', {
      name: 'Updated Name',
    });
    const found = getInstalledDressingBySkillId('sk-upd');
    expect(found!.version).toBe('2.0.0');
    expect(found!.name).toBe('Updated Name');
  });

  it('updates version without name', () => {
    createInstalledDressing({
      id: 'drsg-upd2',
      dressing_type: 'channel',
      dressing_skill_id: 'sk-upd2',
      name: 'Keep Name',
      version: '1.0.0',
      provider_key: null,
      channel_type: 'test-ch',
      folder_name: 'test-ch',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    updateInstalledDressingVersion('drsg-upd2', '1.1.0');
    const found = getInstalledDressingBySkillId('sk-upd2');
    expect(found!.version).toBe('1.1.0');
    expect(found!.name).toBe('Keep Name');
  });

  it('updates config_json', () => {
    createInstalledDressing({
      id: 'drsg-cfg',
      dressing_type: 'agent',
      dressing_skill_id: 'sk-cfg',
      name: 'Config Test',
      version: '1.0.0',
      provider_key: 'cfg-key',
      channel_type: null,
      folder_name: 'cfg-folder',
      config_schema: '{}',
      config_json: null,
      installed_by: null,
    });

    updateInstalledDressingConfig(
      'drsg-cfg',
      '{"base_url":"http://localhost:11434"}',
    );
    const found = getInstalledDressingBySkillId('sk-cfg');
    expect(found!.config_json).toBe('{"base_url":"http://localhost:11434"}');
  });

  it('deletes dressing', () => {
    createInstalledDressing({
      id: 'drsg-del',
      dressing_type: 'agent',
      dressing_skill_id: 'sk-del',
      name: 'Delete Me',
      version: '1.0.0',
      provider_key: 'del-key',
      channel_type: null,
      folder_name: 'del-folder',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    deleteInstalledDressing('drsg-del');
    expect(getInstalledDressingBySkillId('sk-del')).toBeUndefined();
    expect(listInstalledDressings()).toHaveLength(0);
  });

  it('enforces unique dressing_skill_id', () => {
    createInstalledDressing({
      id: 'drsg-uniq1',
      dressing_type: 'agent',
      dressing_skill_id: 'same-skill-id',
      name: 'First',
      version: '1.0.0',
      provider_key: 'p1',
      channel_type: null,
      folder_name: 'f1',
      config_schema: null,
      config_json: null,
      installed_by: null,
    });

    expect(() =>
      createInstalledDressing({
        id: 'drsg-uniq2',
        dressing_type: 'agent',
        dressing_skill_id: 'same-skill-id',
        name: 'Second',
        version: '2.0.0',
        provider_key: 'p2',
        channel_type: null,
        folder_name: 'f2',
        config_schema: null,
        config_json: null,
        installed_by: null,
      }),
    ).toThrow();
  });
});
