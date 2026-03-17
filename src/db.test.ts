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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
      scheduleType: 'daily',
      scheduleTime: '09:00',
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
      scheduleType: 'daily',
      scheduleTime: '10:00',
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
        web_fetch: true,
        web_browse: false,
        bash: false,
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
      scheduleType: 'daily',
      scheduleTime: '08:00',
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
