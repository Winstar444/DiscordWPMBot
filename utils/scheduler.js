import dotenv from 'dotenv';
dotenv.config();

console.log('🔑 Groq Key loaded:', process.env.GROQ_API_KEY ? 'YES' : 'NO - MISSING!');

// Store scheduled tasks in memory
const scheduledTasks = new Map();

// Main function — schedule a task
export async function scheduleTask({ userId, channelId, username, task, taskType, scheduledTime }, discordClient) {

  const scheduledDate = new Date(scheduledTime);
  const now = new Date();
  const delay = scheduledDate.getTime() - now.getTime();

  if (delay <= 0) {
    console.log('⚠️ Scheduled time is in the past!');
    return { success: false, error: 'Scheduled time is in the past' };
  }

  console.log(`📅 Task scheduled for ${username} — runs in ${Math.round(delay / 1000 / 60)} minutes`);

  // Generate task ID
  const taskId = `${userId}-${Date.now()}`;

  // Schedule with setTimeout
  const timeout = setTimeout(async () => {
    await executeTask({ userId, channelId, username, task, taskType }, discordClient);
    scheduledTasks.delete(taskId);
  }, delay);

  // Save to memory
  scheduledTasks.set(taskId, {
    taskId,
    userId,
    channelId,
    username,
    task,
    taskType,
    scheduledTime,
    timeout
  });

  return { success: true, taskId };
}

// Execute task when time comes
async function executeTask({ userId, channelId, username, task, taskType }, discordClient) {
  console.log(`🤖 Executing task for ${username}: ${task}`);

  try {
    const systemPrompt = getPrompt(taskType);
    const result = await callGroq(systemPrompt, task);

    if (!result) {
      await notifyError(discordClient, channelId, userId, username, taskType);
      return;
    }

    await notifySuccess(discordClient, channelId, userId, username, task, taskType, result);

  } catch (error) {
    console.error('❌ Task execution error:', error);
    await notifyError(discordClient, channelId, userId, username, taskType);
  }
}

// Call Groq API with retry logic
async function callGroq(systemPrompt, task, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🔄 Attempt ${i + 1} of ${retries}...`);

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task }
          ],
          max_tokens: 1500,
          temperature: 0.7
        })
      });

      // Rate limit — wait and retry
      if (response.status === 429) {
        const waitTime = (i + 1) * 10000;
        console.log(`⏳ Rate limited. Waiting ${waitTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('❌ Groq error body:', errorBody);
        throw new Error(`Groq error: ${response.status} - ${errorBody}`);
      }

      const data = await response.json();
      console.log('✅ Groq response received!');
      return data.choices[0].message.content;

    } catch (error) {
      console.error(`❌ Attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) {
        console.error('❌ All retries failed');
        return null;
      }
      console.log(`⏳ Waiting 5 seconds before retry...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return null;
}

// Send success notification to Discord
async function notifySuccess(discordClient, channelId, userId, username, task, taskType, result) {
  try {
    const channel = await discordClient.channels.fetch(channelId);
    await channel.send({
      content: `<@${userId}> ✅ Your **${taskType}** task is complete!`,
      embeds: [{
        title: `📚 ${taskType.toUpperCase()} Result`,
        description: result.length > 4096 ? result.substring(0, 4093) + '...' : result,
        color: 0x5865F2,
        fields: [{ name: '📝 Task', value: task, inline: false }],
        footer: { text: `Requested by ${username} • StudyBot AI` },
        timestamp: new Date().toISOString()
      }]
    });

    // DM user
    try {
      const user = await discordClient.users.fetch(userId);
      await user.send({
        content: `Hey ${username}! Your **${taskType}** task is ready 🎉`,
        embeds: [{
          title: `📚 ${taskType.toUpperCase()} Result`,
          description: result.length > 4096 ? result.substring(0, 4093) + '...' : result,
          color: 0x5865F2,
          footer: { text: 'StudyBot AI' }
        }]
      });
    } catch (dmError) {
      console.log('⚠️ Could not send DM — user may have DMs disabled');
    }

    console.log(`✅ Result sent to Discord for ${username}`);

  } catch (error) {
    console.error('❌ Error sending to Discord:', error);
  }
}

// Send error notification to Discord
async function notifyError(discordClient, channelId, userId, username, taskType) {
  try {
    const channel = await discordClient.channels.fetch(channelId);
    await channel.send({
      content: `<@${userId}>`,
      embeds: [{
        title: '❌ Task Failed',
        description: `Sorry ${username}, your **${taskType}** task failed. Please try again.`,
        color: 0xFF0000,
        footer: { text: 'StudyBot AI' }
      }]
    });
  } catch (error) {
    console.error('❌ Error sending error notification:', error);
  }
}

// Get prompt for task type
function getPrompt(taskType) {
  const prompts = {
    quiz:       'Generate 10 MCQs with 4 options each and mark correct answer for this topic:',
    notes:      'Generate detailed well structured study notes with headings for this topic:',
    flashcards: 'Generate 15 flashcards in Q: A: format for this topic:',
    summary:    'Write a clear and concise summary for this topic:',
    plan:       'Create a detailed 7 day study plan with daily tasks for this topic:',
    math:       'Solve this problem step by step showing all working clearly:',
    code:       'Write clean well commented code with detailed explanation for this:',
    translate:  'Translate the following text to Hindi accurately:',
    letter:     'Write a professional formal letter for this request:',
    report:     'Write a detailed well structured report with sections for this topic:',
    mindmap:    'Create a detailed text based mind map with main topics and subtopics for:'
  };
  return prompts[taskType] || 'Answer this question in detail:';
}

// Get all scheduled tasks
export function getScheduledTasks(userId) {
  const tasks = [];
  for (const [id, task] of scheduledTasks) {
    if (task.userId === userId) {
      tasks.push({
        taskId: id,
        task: task.task,
        taskType: task.taskType,
        scheduledTime: task.scheduledTime
      });
    }
  }
  return tasks;
}

// Cancel a scheduled task
export function cancelTask(taskId) {
  const task = scheduledTasks.get(taskId);
  if (task) {
    clearTimeout(task.timeout);
    scheduledTasks.delete(taskId);
    return true;
  }
  return false;
}