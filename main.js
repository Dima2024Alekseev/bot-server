const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Bot } = require('grammy');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const token = process.env.BOT_TOKEN;
const configuredAdminChatIds = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const adminChatIds = new Set(configuredAdminChatIds);
const processName = process.env.PM2_PROCESS_NAME;

if (!token) {
  throw new Error('BOT_TOKEN is not set. Copy .env.example to .env and configure it.');
}

if (adminChatIds.size !== 2 || [...adminChatIds].some((id) => !/^[1-9]\d*$/.test(id))) {
  throw new Error('Set exactly two administrator chat IDs in ADMIN_CHAT_IDS.');
}

if (!processName || !/^[A-Za-z0-9_.@:-]+$/.test(processName) || processName.startsWith('-')) {
  throw new Error('Set PM2_PROCESS_NAME to the exact PM2 process name.');
}

const dataDirectory = path.join(__dirname, 'data');
const remindersFile = path.join(dataDirectory, 'reminders.json');
fs.mkdirSync(dataDirectory, { recursive: true });

function loadReminders() {
  try {
    const data = JSON.parse(fs.readFileSync(remindersFile, 'utf8'));
    if (!Array.isArray(data)) {
      throw new Error('Expected an array of reminders.');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Could not read ${remindersFile}: ${error.message}`);
  }
}

let reminders = loadReminders();

function saveReminders() {
  const temporaryFile = `${remindersFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(reminders, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, remindersFile);
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: error ? error.code : 0,
      };

      if (error && !allowFailure) {
        reject(new Error(result.stderr || result.stdout || error.message));
        return;
      }

      resolve(result);
    });
  });
}

function issueSignature(issue) {
  return issue.trim().toLowerCase();
}

async function getHealthSnapshot() {
  const statusResult = await run('pm2', ['jlist']);
  const processes = JSON.parse(statusResult.stdout);
  const processInfo = processes.find((entry) => entry.name === processName);
  const state = processInfo?.pm2_env?.status || 'not found';
  const logsResult = await run('pm2', ['logs', processName, '--lines', '100', '--nostream']);
  const logText = [logsResult.stdout, logsResult.stderr].filter(Boolean).join('\n');
  const logIssues = [...new Set(
    logText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && problemLogPatterns.some((pattern) => pattern.test(line)))
      .map((line) => line.slice(0, 800)),
  )].slice(-20);

  return { state, logIssues };
}

const bot = new Bot(token);
const commandHandlers = [];
const pendingConfirmations = new Map();
const cancelConfirmationText = '↩️ Отмена';
const cancelReminderText = '↩️ Отменить напоминание';
const reminderDurations = new Map([
  ['10 минут', 10 * 60 * 1000],
  ['30 минут', 30 * 60 * 1000],
  ['1 час', 60 * 60 * 1000],
  ['1,5 часа', 90 * 60 * 1000],
]);
const menuKeyboard = {
  keyboard: [
    ['📊 Статус', '📋 Логи'],
    ['▶️ Запустить', '🔄 Перезапустить'],
    ['⏹ Остановить', '⏰ Напоминание'],
    ['🗓 Мои напоминания', 'ℹ️ Помощь'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const reminderDurationKeyboard = {
  keyboard: [
    ['10 минут', '30 минут'],
    ['1 час', '1,5 часа'],
    [cancelReminderText],
  ],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const problemLogPatterns = [
  /\b(?:ERROR|FATAL|CRITICAL)\b/i,
  /Unhandled (?:exception|rejection)/i,
  /\bEADDRINUSE\b/i,
  /exited with code \[[1-9]\d*\]/i,
  /\b(?:errored|crashed|uncaught exception)\b/i,
];

function isAdmin(message) {
  return message.chat.type === 'private' && adminChatIds.has(String(message.chat.id));
}

async function reply(message, text, keyboard = menuKeyboard) {
  await bot.api.sendMessage(message.chat.id, text, { reply_markup: keyboard });
}

function onAdminCommand(regex, handler) {
  commandHandlers.push({ regex, handler });
}

async function executeCommand(message, text) {
  const command = commandHandlers
    .map(({ regex, handler }) => ({ match: regex.exec(text), handler }))
    .find(({ match }) => match);
  if (!command) {
    return;
  }

  try {
    await command.handler(message, command.match);
  } catch (error) {
    console.error(`Command failed: ${error.message}`);
    await reply(message, `Ошибка: ${error.message}`);
  }
}

bot.on('message:text', async (context) => {
  const message = context.message;
  if (!isAdmin(message)) {
    return;
  }

  const chatId = String(message.chat.id);
  const pending = pendingConfirmations.get(chatId);
  if (pending) {
    pendingConfirmations.delete(chatId);
    if (pending.expiresAt > Date.now() && message.text === pending.confirmText) {
      await executeCommand(message, `/${pending.command}`);
      return;
    }
    if (pending.expiresAt > Date.now() && message.text === cancelConfirmationText) {
      await reply(message, 'Действие отменено.');
      return;
    }
  }

  const actions = new Map([
    ['📊 Статус', '/status'],
    ['📋 Логи', '/logs'],
    ['▶️ Запустить', '/startserver'],
    ['🗓 Мои напоминания', '/reminders'],
    ['ℹ️ Помощь', '/help'],
  ]);

  if (message.text === '↩️ Отмена' || message.text === cancelReminderText) {
    pendingConfirmations.delete(chatId);
    await reply(message, 'Действие отменено.');
    return;
  }

  if (message.text === '⏰ Напоминание') {
    await reply(message, 'Через какое время отправить напоминание?', reminderDurationKeyboard);
    return;
  }

  const durationMs = reminderDurations.get(message.text);
  if (durationMs) {
    try {
      const snapshot = await getHealthSnapshot();
      const timestamp = new Date(Date.now() + durationMs).toISOString();
      const ownMonitors = reminders.filter(
        (reminder) => reminder.type === 'health-check' && reminder.chatId === chatId,
      );
      reminders = reminders.filter(
        (reminder) => !(reminder.type === 'health-check' && reminder.chatId === chatId),
      );

      const monitor = {
        id: randomUUID().slice(0, 8),
        type: 'health-check',
        chatId,
        timestamp,
        baselineLogIssues: snapshot.logIssues.map(issueSignature),
        alertedLogIssues: [],
        observedIssues: [],
        lastReportedStatus: null,
      };

      reminders.push(monitor);
      saveReminders();
      if (snapshot.state !== 'online') {
        const statusIssue = `PM2-процесс «${processName}» сейчас имеет статус: ${snapshot.state}.`;
        try {
          await bot.api.sendMessage(chatId, `Срочное уведомление:\n${statusIssue}`);
          monitor.lastReportedStatus = snapshot.state;
          monitor.observedIssues.push(statusIssue);
          saveReminders();
        } catch (error) {
          console.error(`Could not deliver initial health alert to ${chatId}: ${error.message}`);
        }
      }

      await reply(
        message,
        `Наблюдение включено на ${message.text}. Проверяю PM2 и логи каждые 30 секунд. В конце пришлю результат только вам.${ownMonitors.length ? '\nВаше предыдущее наблюдение заменено.' : ''}`,
      );
    } catch (error) {
      console.error(`Could not start health monitoring for ${chatId}: ${error.message}`);
      await reply(message, `Не удалось включить наблюдение: ${error.message}`);
    }
    return;
  }

  if (actions.has(message.text)) {
    await executeCommand(message, actions.get(message.text));
    return;
  }

  const confirmations = new Map([
    ['🔄 Перезапустить', { command: 'restartserver', confirmText: '✅ Да, перезапустить' }],
    ['⏹ Остановить', { command: 'stopserver', confirmText: '✅ Да, остановить' }],
  ]);
  const confirmation = confirmations.get(message.text);
  if (confirmation) {
    pendingConfirmations.set(chatId, { ...confirmation, expiresAt: Date.now() + 60_000 });
    await reply(
      message,
      `Подтвердите действие с сервером «${processName}» в течение минуты:`,
      {
        keyboard: [[confirmation.confirmText], [cancelConfirmationText]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    );
    return;
  }

  await executeCommand(message, message.text);
});

onAdminCommand(/^\/(?:start|help)(?:@\w+)?$/, async (message) => {
  await reply(
    message,
    [
      'Команды управления сервером в PM2:',
      '/status — состояние процесса',
      '/logs [1-100] — последние строки логов',
      '/startserver — запустить остановленный процесс',
      '/stopserver — остановить процесс',
      '/restartserver — перезапустить процесс',
      'Для напоминания нажмите кнопку «⏰ Напоминание» и выберите интервал.',
      'Бот проверяет PM2 и ошибки в логах каждые 30 секунд; уведомления и итоговый статус отправляются только вам.',
      '/reminders — список ваших напоминаний',
      '/cancelreminder ID — отменить напоминание',
    ].join('\n'),
  );
});

onAdminCommand(/^\/status(?:@\w+)?$/, async (message) => {
  const result = await run('pm2', ['jlist']);
  const processes = JSON.parse(result.stdout);
  const target = processes.find((processInfo) => processInfo.name === processName);
  if (!target) {
    await reply(message, `Процесс "${processName}" не найден в PM2.`);
    return;
  }

  const state = target.pm2_env?.status || 'неизвестно';
  await reply(message, `Процесс ${processName}: ${state}`);
});

onAdminCommand(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/, async (message, match) => {
  const lines = Number(match[1] || 30);
  if (!Number.isInteger(lines) || lines < 1 || lines > 100) {
    await reply(message, 'Укажите число строк от 1 до 100: /logs 30');
    return;
  }

  const result = await run('pm2', ['logs', processName, '--lines', String(lines), '--nostream']);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(Логи пусты.)';
  await reply(message, output.length > 3800 ? `${output.slice(-3800)}\n…вывод сокращён` : output);
});

for (const [command, action, verb] of [
  ['startserver', 'restart', 'запущен'],
  ['stopserver', 'stop', 'остановлен'],
  ['restartserver', 'restart', 'перезапущен'],
]) {
  onAdminCommand(new RegExp(`^\\/${command}(?:@\\w+)?$`), async (message) => {
    await run('pm2', [action, processName]);
    await reply(message, `Команда выполнена: процесс ${processName} ${verb}.`);
  });
}

onAdminCommand(/^\/reminders(?:@\w+)?$/, async (message) => {
  const ownReminders = reminders.filter((reminder) => reminder.chatId === String(message.chat.id));
  if (ownReminders.length === 0) {
    await reply(message, 'У вас нет запланированных напоминаний.');
    return;
  }

  await reply(
    message,
    ownReminders
      .map((reminder) => {
        const description = reminder.type === 'health-check'
          ? 'автоматическая проверка сервера'
          : reminder.text;
        return `${reminder.id} — ${reminder.timestamp}: ${description}`;
      })
      .join('\n'),
  );
});

onAdminCommand(/^\/cancelreminder(?:@\w+)?\s+([a-f0-9-]+)$/i, async (message, match) => {
  const index = reminders.findIndex(
    (reminder) => reminder.id === match[1] && reminder.chatId === String(message.chat.id),
  );
  if (index === -1) {
    await reply(message, 'Напоминание не найдено.');
    return;
  }

  reminders.splice(index, 1);
  saveReminders();
  await reply(message, 'Напоминание отменено.');
});

let checkingReminders = false;
async function deliverDueReminders() {
  if (checkingReminders) {
    return;
  }
  checkingReminders = true;

  try {
    const now = Date.now();
    const healthChecks = reminders.filter((reminder) => reminder.type === 'health-check');
    const dueLegacyReminders = reminders.filter(
      (reminder) => reminder.type !== 'health-check' && Date.parse(reminder.timestamp) <= now,
    );
    if (healthChecks.length === 0 && dueLegacyReminders.length === 0) {
      return;
    }

    let snapshot;
    let snapshotError;
    if (healthChecks.length > 0) {
      try {
        snapshot = await getHealthSnapshot();
      } catch (error) {
        snapshotError = error;
        console.error(`Health check failed: ${error.message}`);
      }
    }

    for (const monitor of healthChecks) {
      const due = Date.parse(monitor.timestamp) <= now;
      const newAlerts = [];
      const newLogIssues = [];
      const newObservedIssues = [];
      let dirty = false;
      let alertDeliveryFailed = false;
      let nextReportedStatus = monitor.lastReportedStatus;
      let nextCheckError = monitor.lastCheckError || null;

      if (snapshotError) {
        const errorText = `Не удалось проверить сервер: ${snapshotError.message}`;
        if (nextCheckError !== snapshotError.message) {
          newAlerts.push(errorText);
          newObservedIssues.push(errorText);
          nextCheckError = snapshotError.message;
        }
      } else {
        if (nextCheckError) {
          nextCheckError = null;
          dirty = true;
        }

        if (snapshot.state === 'online') {
          if (nextReportedStatus !== null) {
            nextReportedStatus = null;
            dirty = true;
          }
        } else if (nextReportedStatus !== snapshot.state) {
          const statusIssue = `PM2-процесс «${processName}» имеет статус: ${snapshot.state}.`;
          newAlerts.push(statusIssue);
          newObservedIssues.push(statusIssue);
          nextReportedStatus = snapshot.state;
        }

        const baseline = new Set(monitor.baselineLogIssues || []);
        const alerted = new Set(monitor.alertedLogIssues || []);
        const unseenLogIssues = snapshot.logIssues.filter((issue) => {
          const signature = issueSignature(issue);
          return !baseline.has(signature) && !alerted.has(signature);
        });
        for (const issue of unseenLogIssues.slice(0, 5)) {
          newAlerts.push(`Ошибка в логах: ${issue}`);
          newLogIssues.push(issue);
          newObservedIssues.push(`Ошибка в логах: ${issue}`);
        }
      }

      if (newAlerts.length > 0) {
        try {
          await bot.api.sendMessage(monitor.chatId, `Срочное уведомление:\n${newAlerts.join('\n\n')}`);
          for (const issue of newObservedIssues) {
            if (!monitor.observedIssues.includes(issue)) {
              monitor.observedIssues.push(issue);
            }
          }
          monitor.lastReportedStatus = nextReportedStatus;
          monitor.lastCheckError = nextCheckError;
          if (!snapshotError) {
            const alerted = new Set(monitor.alertedLogIssues || []);
            for (const issue of newLogIssues) {
              alerted.add(issueSignature(issue));
            }
            monitor.alertedLogIssues = [...alerted].slice(-200);
          }
          dirty = true;
        } catch (error) {
          console.error(`Could not deliver immediate health alert to ${monitor.chatId}: ${error.message}`);
          alertDeliveryFailed = true;
        }
      } else {
        monitor.lastReportedStatus = nextReportedStatus;
        monitor.lastCheckError = nextCheckError;
      }

      if (dirty) {
        saveReminders();
      }

      if (due) {
        let report;
        if (snapshotError) {
          report = `Не удалось выполнить итоговую проверку сервера:\n${snapshotError.message}`;
        } else if (
          monitor.observedIssues.length === 0 &&
          newObservedIssues.length === 0 &&
          snapshot.state === 'online'
        ) {
          report = 'Никаких проблем с сервером не обнаружено.';
        } else {
          const issues = [...new Set([...monitor.observedIssues, ...newObservedIssues])];
          if (alertDeliveryFailed) {
            issues.push('Не удалось доставить срочное уведомление; обнаруженные события включены в этот итоговый отчёт.');
          }
          if (snapshot.state !== 'online') {
            const statusIssue = `Текущий статус PM2-процесса: ${snapshot.state}.`;
            if (!issues.includes(statusIssue)) {
              issues.push(statusIssue);
            }
          }
          report = `За время наблюдения обнаружены проблемы:\n${issues.join('\n')}`;
        }

        try {
          await bot.api.sendMessage(monitor.chatId, report.slice(0, 3900));
          reminders = reminders.filter((reminder) => reminder.id !== monitor.id);
          saveReminders();
        } catch (error) {
          console.error(`Could not deliver health report to ${monitor.chatId}: ${error.message}`);
        }
      }
    }

    for (const reminder of dueLegacyReminders) {
      try {
        await bot.api.sendMessage(
          reminder.chatId,
          `Напоминание (${reminder.timestamp}):\n${reminder.text}`,
        );
        reminders = reminders.filter((item) => item.id !== reminder.id);
        saveReminders();
      } catch (error) {
        console.error(`Could not deliver reminder ${reminder.id} to ${reminder.chatId}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Could not process reminders: ${error.message}`);
  } finally {
    checkingReminders = false;
  }
}

setInterval(deliverDueReminders, 30000);
bot.catch((error) => console.error(`Telegram bot error: ${error.message}`));
bot.api.setMyCommands([
  { command: 'status', description: 'Состояние процесса в PM2' },
  { command: 'logs', description: 'Последние строки логов' },
  { command: 'startserver', description: 'Запустить процесс' },
  { command: 'stopserver', description: 'Остановить процесс' },
  { command: 'restartserver', description: 'Перезапустить процесс' },
  { command: 'reminders', description: 'Список напоминаний' },
  { command: 'cancelreminder', description: 'Отменить напоминание' },
]).catch((error) => console.error(`Could not register bot commands: ${error.message}`));

console.log(`Bot started. Managing PM2 process: ${processName}`);
bot.start().catch((error) => {
  console.error(`Could not start Telegram polling: ${error.message}`);
  process.exitCode = 1;
});
