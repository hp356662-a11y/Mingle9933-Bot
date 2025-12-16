require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const userStates = {};

async function getUser(userId) {
  const { data } = await supabase.from('users').select('*').eq('user_id', userId).single();
  return data;
}

async function getPreferences(userId) {
  const { data } = await supabase.from('preferences').select('*').eq('user_id', userId).single();
  return data;
}

async function getNextProfile(userId) {
  const prefs = await getPreferences(userId);
  if (!prefs) return null;

  const { data: swipedUsers } = await supabase.from('swipes').select('swiped_id').eq('swiper_id', userId);
  const swipedIds = swipedUsers?.map(s => s.swiped_id) || [];
  swipedIds.push(userId);

  const query = supabase.from('users').select('*').eq('is_active', true).gte('age', prefs.min_age).lte('age', prefs.max_age);
  
  if (swipedIds.length > 0) {
    query.not('user_id', 'in', `(${swipedIds.join(',')})`);
  }
  
  const { data: profiles } = await query.limit(1);

  if (profiles && profiles.length > 0) {
    const profile = profiles[0];
    if (prefs.looking_for_gender === 'both' || profile.gender === prefs.looking_for_gender) {
      return profile;
    }
  }
  return null;
}

async function checkMatch(userId, swipedUserId) {
  const { data } = await supabase.from('swipes').select('*').eq('swiper_id', swipedUserId).eq('swiped_id', userId).eq('action', 'like').single();
  return data !== null;
}

async function createMatch(user1Id, user2Id) {
  const [smallerId, largerId] = user1Id < user2Id ? [user1Id, user2Id] : [user2Id, user1Id];
  await supabase.from('matches').insert({ user1_id: smallerId, user2_id: largerId });
}

async function getMatches(userId) {
  const { data } = await supabase.from('matches').select('*').or(`user1_id.eq.${userId},user2_id.eq.${userId}`).eq('is_active', true);
  return data || [];
}

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const user = await getUser(userId);
  
  if (user) {
    bot.sendMessage(userId, `Welcome back, ${user.name}! 💕\n\nWhat would you like to do?`, {
      reply_markup: { keyboard: [['🔍 Browse', '💬 Matches'], ['👤 Profile', '⚙️ Settings']], resize_keyboard: true }
    });
  } else {
    bot.sendMessage(userId, `Welcome to Mingle! 💕\n\nFind your perfect match!\n\nLet's create your profile!\n\nFirst, how old are you? (Must be 18+)`, 
      { reply_markup: { remove_keyboard: true } });
    userStates[userId] = { step: 'age' };
  }
});

bot.onText(/\/profile|👤 Profile/, async (msg) => {
  const userId = msg.from.id;
  const user = await getUser(userId);
  
  if (!user) {
    bot.sendMessage(userId, 'Please complete registration first with /start');
    return;
  }
  
  const profileText = `👤 Your Profile:\n\nName: ${user.name}\nAge: ${user.age}\nGender: ${user.gender}\nBio: ${user.bio || 'Not set'}\nLocation: ${user.location || 'Not set'}`;
  bot.sendMessage(userId, profileText);
});

bot.onText(/\/browse|🔍 Browse/, async (msg) => {
  const userId = msg.from.id;
  const user = await getUser(userId);
  
  if (!user) {
    bot.sendMessage(userId, 'Please complete registration first with /start');
    return;
  }
  
  const profile = await getNextProfile(userId);
  
  if (!profile) {
    bot.sendMessage(userId, `No more profiles to show right now! 😔\n\nCheck back later or adjust your preferences.`);
    return;
  }
  
  const profileText = `${profile.name}, ${profile.age}\n${profile.gender}\n${profile.location || 'Location not set'}\n\n${profile.bio || 'No bio yet'}`;
  
  bot.sendMessage(userId, profileText, {
    reply_markup: {
      inline_keyboard: [[
        { text: '❌ Pass', callback_data: `pass_${profile.user_id}` },
        { text: '❤️ Like', callback_data: `like_${profile.user_id}` }
      ]]
    }
  });
});

bot.onText(/\/matches|💬 Matches/, async (msg) => {
  const userId = msg.from.id;
  const matches = await getMatches(userId);
  
  if (matches.length === 0) {
    bot.sendMessage(userId, `You don't have any matches yet! 💔\n\nKeep swiping to find your match!`);
    return;
  }
  
  let matchText = `💕 Your Matches (${matches.length}):\n\n`;
  
  for (const match of matches) {
    const matchedUserId = match.user1_id === userId ? match.user2_id : match.user1_id;
    const matchedUser = await getUser(matchedUserId);
    if (matchedUser) {
      matchText += `• ${matchedUser.name}, ${matchedUser.age}\n`;
    }
  }
  
  bot.sendMessage(userId, matchText);
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  
  if (data.startsWith('like_') || data.startsWith('pass_')) {
    const [action, swipedUserId] = data.split('_');
    
    await supabase.from('swipes').insert({
      swiper_id: userId,
      swiped_id: parseInt(swipedUserId),
      action: action
    });
    
    if (action === 'like') {
      const isMatch = await checkMatch(userId, parseInt(swipedUserId));
      
      if (isMatch) {
        await createMatch(userId, parseInt(swipedUserId));
        const matchedUser = await getUser(parseInt(swipedUserId));
        
        bot.answerCallbackQuery(query.id, { text: `It's a match! 🎉` });
        bot.sendMessage(userId, `🎉 It's a Match!\n\nYou and ${matchedUser.name} liked each other!`);
        bot.sendMessage(swipedUserId, `🎉 It's a Match!\n\nYou and ${query.from.first_name} liked each other!`);
      } else {
        bot.answerCallbackQuery(query.id, { text: 'Liked! ❤️' });
      }
    } else {
      bot.answerCallbackQuery(query.id, { text: 'Passed ❌' });
    }
    
    setTimeout(() => {
      bot.sendMessage(userId, 'Loading next profile...');
      bot.emit('message', { text: '/browse', from: { id: userId }, chat: { id: userId } });
    }, 1000);
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!userStates[userId] || text?.startsWith('/')) return;
  
  const state = userStates[userId];
  
  if (state.step === 'age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 18) {
      bot.sendMessage(userId, 'Please enter a valid age (18 or older):');
      return;
    }
    state.age = age;
    state.step = 'name';
    bot.sendMessage(userId, 'Great! What\'s your name?');
  }
  else if (state.step === 'name') {
    state.name = text;
    state.step = 'gender';
    bot.sendMessage(userId, 'Nice to meet you! What\'s your gender?', {
      reply_markup: { keyboard: [['Male', 'Female', 'Other']], one_time_keyboard: true, resize_keyboard: true }
    });
  }
  else if (state.step === 'gender') {
    state.gender = text.toLowerCase();
    state.step = 'bio';
    bot.sendMessage(userId, 'Tell us about yourself (bio):', { reply_markup: { remove_keyboard: true } });
  }
  else if (state.step === 'bio') {
    state.bio = text;
    state.step = 'location';
    bot.sendMessage(userId, 'Where are you located? (City/Area)');
  }
  else if (state.step === 'location') {
    state.location = text;
    state.step = 'looking_for';
    bot.sendMessage(userId, 'Who are you looking for?', {
      reply_markup: { keyboard: [['Men', 'Women', 'Both']], one_time_keyboard: true, resize_keyboard: true }
    });
  }
  else if (state.step === 'looking_for') {
    const lookingFor = text.toLowerCase() === 'men' ? 'male' : text.toLowerCase() === 'women' ? 'female' : 'both';
    
    await supabase.from('users').insert({
      user_id: userId,
      name: state.name,
      age: state.age,
      gender: state.gender,
      bio: state.bio,
      location: state.location
    });
    
    await supabase.from('preferences').insert({
      user_id: userId,
      looking_for_gender: lookingFor,
      min_age: 18,
      max_age: 99
    });
    
    delete userStates[userId];
    
    bot.sendMessage(userId, `✅ Profile created successfully!\n\nYou're all set! Start browsing to find your match! 💕`, {
      reply_markup: { keyboard: [['🔍 Browse', '💬 Matches'], ['👤 Profile', '⚙️ Settings']], resize_keyboard: true }
    });
  }
});

console.log('🤖 Mingle Bot is running...');
