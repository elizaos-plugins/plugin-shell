import { describe, it, expect, beforeEach, vi, afterEach, beforeAll } from 'vitest';
import {
  type IAgentRuntime,
  type Memory,
  type State,
  ModelType,
  ContentType,
} from '@elizaos/core';
import { ShellService } from '../service';
import { shellProvider } from '../provider';
import { runShellCommandAction, clearShellHistoryAction, killAutonomousAction } from '../action';
import * as child_process from 'child_process';

// Mock child_process
vi.mock('child_process');

// Mock the core logger to silence output during tests
vi.mock('@elizaos/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@elizaos/core')>();
  return {
    ...original,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('ShellService', () => {
  let shellService: ShellService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Mock the runtime
    mockRuntime = {
      agentId: 'test-agent-id',
      getService: vi.fn(),
      createMemory: vi.fn(),
      composeState: vi.fn(),
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    shellService = new ShellService(mockRuntime);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with the correct CWD', () => {
    expect(shellService.getCurrentWorkingDirectory()).toBe(process.cwd());
  });

  it('should execute a simple command successfully', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('hello' as any);

    const result = await shellService.executeCommand('echo hello');

    expect(mockExecSync).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({
        cwd: process.cwd(),
        encoding: 'utf-8',
        shell: expect.any(String),
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello');
    expect(result.error).toBeUndefined();
    expect(result.cwd).toBe(process.cwd());
  });

  it('should handle a failing command and capture stderr', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    const error = new Error('Command failed') as any;
    error.stderr =
      "ls: cannot access '/nonexistent-directory-for-testing': No such file or directory";
    error.stdout = '';
    error.status = 2;
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const result = await shellService.executeCommand('ls /nonexistent-directory-for-testing');

    expect(result.exitCode).toBe(2);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('No such file or directory');
  });

  it('should change the current working directory with cd', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('' as any);

    const initialCwd = shellService.getCurrentWorkingDirectory();
    const parentDir = require('path').resolve(initialCwd, '..');

    const result = await shellService.executeCommand('cd ..');

    expect(result.exitCode).toBe(0);
    expect(shellService.getCurrentWorkingDirectory()).toBe(parentDir);
    expect(result.output).toContain('Changed directory to');

    // Change back to the original directory
    await shellService.executeCommand(`cd ${initialCwd}`);
    expect(shellService.getCurrentWorkingDirectory()).toBe(initialCwd);
  });

  it('should handle invalid cd command', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    const error = new Error('Command failed') as any;
    error.message = 'ENOENT: no such file or directory';
    error.status = 1;
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const initialCwd = shellService.getCurrentWorkingDirectory();
    const result = await shellService.executeCommand('cd /nonexistent-directory-for-testing');

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Error changing directory');
    expect(shellService.getCurrentWorkingDirectory()).toBe(initialCwd);
  });

  it('should record command history', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValueOnce('test1' as any);
    mockExecSync.mockReturnValueOnce('test2' as any);

    await shellService.executeCommand('echo test1');
    await shellService.executeCommand('echo test2');

    const history = shellService.getHistory(2);
    expect(history.length).toBe(2);
    expect(history[0].command).toBe('echo test1');
    expect(history[0].output).toBe('test1');
    expect(history[1].command).toBe('echo test2');
    expect(history[1].output).toBe('test2');
  });

  it('should limit history to maxHistoryLength', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);

    // Execute more than maxHistoryLength commands
    for (let i = 0; i < 110; i++) {
      mockExecSync.mockReturnValueOnce(`output${i}` as any);
      await shellService.executeCommand(`echo test${i}`);
    }

    const history = shellService.getHistory(200); // Request more than max
    expect(history.length).toBe(100); // Should be capped at maxHistoryLength
  });

  it('should clear command history', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('test1' as any);

    await shellService.executeCommand('echo test1');
    shellService.clearHistory();
    const history = shellService.getHistory();
    expect(history.length).toBe(0);
  });

  it('should track file operations', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('' as any);

    // Execute file operation commands
    await shellService.executeCommand('touch testfile.txt');
    await shellService.executeCommand('cat testfile.txt');
    await shellService.executeCommand('rm testfile.txt');

    const fileOps = shellService.getFileOperationHistory();
    expect(fileOps.length).toBeGreaterThan(0);

    const operations = fileOps.map((op) => op.operationType);
    expect(operations).toContain('write');
    expect(operations).toContain('read');
    expect(operations).toContain('delete');
  });

  it('should handle complex file operations', async () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('' as any);

    await shellService.executeCommand('mv source.txt dest.txt');
    await shellService.executeCommand('cp file1.txt file2.txt');

    const fileOps = shellService.getFileOperationHistory();
    const moveOp = fileOps.find((op) => op.operationType === 'move');
    const copyOp = fileOps.find((op) => op.operationType === 'copy');

    expect(moveOp).toBeDefined();
    expect(moveOp?.secondaryTarget).toBeDefined();
    expect(copyOp).toBeDefined();
    expect(copyOp?.secondaryTarget).toBeDefined();
  });
});

describe('ShellProvider', () => {
  let mockRuntime: IAgentRuntime;
  let mockShellService: ShellService;
  let mockMemory: Memory;
  let mockState: State;

  beforeEach(() => {
    mockShellService = {
      getHistory: vi.fn().mockReturnValue([
        {
          command: 'ls -la',
          output: 'total 64\ndrwxr-xr-x  10 user  staff   320 Dec  5 10:00 .',
          exitCode: 0,
          timestamp: Date.now() - 60000,
          cwd: '/home/user',
        },
        {
          command: 'echo test',
          output: 'test',
          error: '',
          exitCode: 0,
          timestamp: Date.now() - 30000,
          cwd: '/home/user',
        },
      ]),
      getCurrentWorkingDirectory: vi.fn().mockReturnValue('/home/user'),
    } as unknown as ShellService;

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockShellService),
    } as unknown as IAgentRuntime;

    mockMemory = {
      id: '00000000-0000-0000-0000-000000000001',
      entityId: '00000000-0000-0000-0000-000000000002',
      content: { text: 'test' },
      agentId: '00000000-0000-0000-0000-000000000003',
      roomId: '00000000-0000-0000-0000-000000000004',
      createdAt: Date.now(),
    } as Memory;

    mockState = {
      values: {},
      data: {},
      text: '',
    } as State;
  });

  it('should provide shell history and current directory', async () => {
    const result = await shellProvider.get(mockRuntime, mockMemory, mockState);

    expect(result).toBeDefined();
    expect(result!.values).toBeDefined();
    expect(result!.data).toBeDefined();
    expect(result!.values!.currentWorkingDirectory).toBe('/home/user');
    expect(result!.values!.shellHistory).toContain('ls -la');
    expect(result!.values!.shellHistory).toContain('echo test');
    expect(result!.text).toContain('Current Directory: /home/user');
    expect(result!.data!.history).toHaveLength(2);
    expect(result!.data!.cwd).toBe('/home/user');
  });

  it('should handle missing shell service', async () => {
    mockRuntime.getService = vi.fn().mockReturnValue(null);

    const result = await shellProvider.get(mockRuntime, mockMemory, mockState);

    expect(result).toBeDefined();
    expect(result!.values).toBeDefined();
    expect(result!.values!.shellHistory).toBe('Shell service is not available.');
    expect(result!.values!.currentWorkingDirectory).toBe('N/A');
    expect(result!.text).toContain('Shell service is not available.');
  });

  it('should truncate very long output', async () => {
    const longOutput = 'x'.repeat(10000);
    mockShellService.getHistory = vi.fn().mockReturnValue([
      {
        command: 'cat largefile',
        output: longOutput,
        exitCode: 0,
        timestamp: Date.now(),
        cwd: '/home/user',
      },
    ]);

    const result = await shellProvider.get(mockRuntime, mockMemory, mockState);

    expect(result).toBeDefined();
    expect(result!.values).toBeDefined();
    expect(result!.values!.shellHistory).toContain('[TRUNCATED]');
    expect(result!.values!.shellHistory.length).toBeLessThan(longOutput.length);
  });
});

describe('Shell Actions', () => {
  let mockRuntime: IAgentRuntime;
  let mockShellService: ShellService;
  let mockMemory: Memory;
  let mockState: State;
  let mockCallback: any;

  beforeEach(() => {
    mockShellService = {
      executeCommand: vi.fn().mockResolvedValue({
        output: 'command output',
        error: '',
        exitCode: 0,
        cwd: '/home/user',
      }),
      clearHistory: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      getCurrentWorkingDirectory: vi.fn().mockReturnValue('/home/user'),
    } as unknown as ShellService;

    mockRuntime = {
      agentId: 'test-agent-id',
      getService: vi.fn().mockReturnValue(mockShellService),
      createMemory: vi.fn(),
      composeState: vi.fn().mockResolvedValue({
        values: {},
        data: {},
        text: 'test state',
      }),
      useModel: vi.fn().mockResolvedValue('<response><command>ls -la</command></response>'),
    } as unknown as IAgentRuntime;

    mockMemory = {
      id: '00000000-0000-0000-0000-000000000005',
      entityId: '00000000-0000-0000-0000-000000000006',
      content: { text: 'list files' },
      agentId: '00000000-0000-0000-0000-000000000007',
      roomId: '00000000-0000-0000-0000-000000000008',
      worldId: '00000000-0000-0000-0000-000000000009',
      createdAt: Date.now(),
    } as Memory;

    mockState = {
      values: {},
      data: {},
      text: '',
    } as State;

    mockCallback = vi.fn();
  });

  describe('runShellCommandAction', () => {
    it('should validate when shell service is available', async () => {
      const isValid = await runShellCommandAction.validate(mockRuntime, mockMemory, mockState);
      expect(isValid).toBe(true);
    });

    it('should not validate when shell service is unavailable', async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const isValid = await runShellCommandAction.validate(mockRuntime, mockMemory, mockState);
      expect(isValid).toBe(false);
    });

    it('should execute command from options', async () => {
      await runShellCommandAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        { command: 'pwd' },
        mockCallback
      );

      expect(mockShellService.executeCommand).toHaveBeenCalledWith('pwd');
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('Analyzed output'),
          text: expect.any(String),
          attachments: expect.arrayContaining([
            expect.objectContaining({
              contentType: ContentType.DOCUMENT,
              text: expect.stringContaining('"command": "pwd"'),
            }),
          ]),
        })
      );
    });

    it('should extract command from natural language', async () => {
      await runShellCommandAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({ prompt: expect.stringContaining('extract') })
      );
      expect(mockShellService.executeCommand).toHaveBeenCalledWith('ls -la');
    });

    it('should handle direct shell commands', async () => {
      mockMemory.content.text = 'ls -la';

      await runShellCommandAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockShellService.executeCommand).toHaveBeenCalledWith('ls -la');
    });

    it('should quote wildcards for find and grep commands', async () => {
      mockMemory.content.text = 'find . -name *.txt';

      await runShellCommandAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockShellService.executeCommand).toHaveBeenCalledWith("find . -name '*.txt'");
    });

    it('should handle command execution errors', async () => {
      // This test intentionally causes an error to verify that the
      // action's error handling works correctly. The `ERROR` log that
      // may appear in the console is expected for this test case.
      mockShellService.executeCommand = vi.fn().mockRejectedValue(new Error('Command failed'));

      await runShellCommandAction.handler(
        mockRuntime,
        mockMemory,
        mockState,
        { command: 'bad-command' },
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: expect.stringContaining('unexpected error'),
          text: expect.stringContaining('Error during shell command execution'),
        })
      );
    });
  });

  describe('clearShellHistoryAction', () => {
    it('should clear shell history', async () => {
      await clearShellHistoryAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockShellService.clearHistory).toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: 'Shell history has been cleared successfully.',
          text: 'Shell command history has been cleared.',
        })
      );
    });

    it('should handle missing shell service', async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      await clearShellHistoryAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: 'ShellService is not available. Cannot clear history.',
          text: 'I am currently unable to clear shell history.',
        })
      );
    });
  });

  describe('killAutonomousAction', () => {
    it('should stop autonomous service', async () => {
      const mockAutonomousService = {
        stop: vi.fn(),
      };
      mockRuntime.getService = vi.fn((name) =>
        name === 'AUTONOMOUS' ? mockAutonomousService : mockShellService
      ) as any;

      await killAutonomousAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockAutonomousService.stop).toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: 'Successfully stopped the autonomous agent loop.',
          text: expect.stringContaining('Autonomous loop has been killed'),
        })
      );
    });

    it('should handle missing autonomous service', async () => {
      mockRuntime.getService = vi.fn((name) => (name === 'SHELL' ? mockShellService : null)) as any;

      await killAutonomousAction.handler(mockRuntime, mockMemory, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          thought: 'Autonomous service not found or already stopped.',
          text: expect.stringContaining('No autonomous loop was running'),
        })
      );
    });
  });
});
