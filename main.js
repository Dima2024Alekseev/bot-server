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

const bot = new Bot(token);
const commandHandlers = [];
const pendingConfirmations = new Map();
const cancelConfirmationText = '↩️ Отмена';
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
    ['⏰ Напоминание', '/remind'],
    ['🗓 Мои напоминания', '/reminders'],
    ['ℹ️ Помощь', '/help'],
  ]);
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
      '/remind YYYY-MM-DDTHH:mm:ss+07:00 текст — создать напоминание',
      '/reminders — список ваших напоминаний',
      '/cancelreminder ID — отменить напоминание',
      '',
      'Время указывайте с часовым поясом (например, +07:00 или Z).',
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

function parseReminderDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offsetHourText && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))
  ) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? new Date(timestamp) : null;
}

onAdminCommand(/^\/remind(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/, async (message, match) => {
  const date = parseReminderDate(match[1]);
  const text = match[2].trim();

  if (!date) {
    await reply(message, 'Неверное или прошедшее время. Укажите дату ISO с часовым поясом, например YYYY-MM-DDTHH:mm:ss+07:00.');
    return;
  }
  if (!text || text.length > 1000) {
    await reply(message, 'Текст напоминания должен содержать от 1 до 1000 символов.');
    return;
  }

  const reminder = {
    id: randomUUID().slice(0, 8),
    chatId: String(message.chat.id),
    timestamp: date.toISOString(),
    text,
  };
  reminders.push(reminder);
  saveReminders();
  await reply(message, `Напоминание ${reminder.id} запланировано на ${date.toISOString()}.`);
});

onAdminCommand(/^\/remind(?:@\w+)?$/, async (message) => {
  await reply(message, 'Формат: /remind YYYY-MM-DDTHH:mm:ss+07:00 текст напоминания');
});

onAdminCommand(/^\/reminders(?:@\w+)?$/, async (message) => {
  const ownReminders = reminders.filter((reminder) => reminder.chatId === String(message.chat.id));
  if (ownReminders.length === 0) {
    await reply(message, 'У вас нет запланированных напоминаний.');
    return;
  }

  await reply(
    message,
    ownReminders
      .map((reminder) => `${reminder.id} — ${reminder.timestamp}: ${reminder.text}`)
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
    const due = reminders.filter((reminder) => Date.parse(reminder.timestamp) <= Date.now());
    if (due.length === 0) {
      return;
    }

    for (const reminder of due) {
      if (!Array.isArray(reminder.deliveredChatIds)) {
        reminder.deliveredChatIds = [];
      }

      for (const chatId of adminChatIds) {
        if (reminder.deliveredChatIds.includes(chatId)) {
          continue;
        }

        try {
          await bot.api.sendMessage(chatId, `Напоминание (${reminder.timestamp}):\n${reminder.text}`);
          reminder.deliveredChatIds.push(chatId);
          saveReminders();
        } catch (error) {
          console.error(`Could not deliver reminder ${reminder.id} to ${chatId}: ${error.message}`);
        }
      }

      if ([...adminChatIds].every((chatId) => reminder.deliveredChatIds.includes(chatId))) {
        reminders = reminders.filter((item) => item.id !== reminder.id);
        saveReminders();
      }
    }
  } catch (error) {
    console.error(`Could not process reminders: ${error.message}`);
  } finally {
    checkingReminders = false;
  }
}

setInterval(deliverDueReminders, 15000);
bot.catch((error) => console.error(`Telegram bot error: ${error.message}`));
bot.api.setMyCommands([
  { command: 'status', description: 'Состояние процесса в PM2' },
  { command: 'logs', description: 'Последние строки логов' },
  { command: 'startserver', description: 'Запустить процесс' },
  { command: 'stopserver', description: 'Остановить процесс' },
  { command: 'restartserver', description: 'Перезапустить процесс' },
  { command: 'remind', description: 'Создать напоминание' },
  { command: 'reminders', description: 'Список напоминаний' },
  { command: 'cancelreminder', description: 'Отменить напоминание' },
]).catch((error) => console.error(`Could not register bot commands: ${error.message}`));

console.log(`Bot started. Managing PM2 process: ${processName}`);
bot.start().catch((error) => {
  console.error(`Could not start Telegram polling: ${error.message}`);
  process.exitCode = 1;
});
