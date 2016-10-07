//from https://github.com/howdyai/botkit
if (!process.env.token || !process.env.channel) {
    console.log('Error: Specify token and channel in environment');
    process.exit(1);
}

var Botkit = require('botkit'),
    moment = require('moment'),
    os     = require('os'),

    channelId, //own private channel id
    channelInfo, //own private channel info
    teamUsers, //users in all of the slack group
    channelUserNamesAll, //original list of all users in private channel
    channelUserNamesCurrent, //list of users in private channel, possibly with users removed
    prev, //User that was selected previously
    botName,
    requestRestart,
    bannedUsers = ['Vincent Eberle'];

var controller = Botkit.slackbot({
  debug: false
});

var bot = controller.spawn({
  token: process.env.token
}).startRTM();


/**
 * RESET FUNCTIONALITY
 * - resetController: determine which reset to call
 * - dailyReset: retore all users
 * - weeklyReset: restore all users & reset PR counts
 * - boot
 */

/* start */
controller.on('rtm_open', function() {
  boot(bot);
});

function resetController(bot) {
  // get moment object for 9am tomorrow
  var now        = moment(),
      timeToFire = moment().add(1, 'days').hour(9).minute(0).second(0);

  // perform appropriate reset for today
  if (now.weekday() === 1)
    say(weeklyReset(), bot); // weekly reset on Mondays
  else
    say(dailyReset(), bot); // daily reset for all other weekdays

  // if timeToFire is weekend, add 2 days (=> Monday)
  if (timeToFire.weekday() > 5)
    timeToFire.add(2, 'days');

  // run this again "timeToFire"
  setTimeout(function() {
    resetController(bot)
  }, timeToFire - now);
}

/* daily reset functions */
function dailyReset() {
  // restore all users
  return 'Good Morning. ' + restoreUsers();
}

/* weekly reset functions */
function weeklyReset() {
  // restore all users
  restoreUsers();
  // reset PR count
  resetPRCount();

  return 'Happy Monday! All users and PR counts have been reset\n' + printCurrent();
}

/* boot up */
function boot(bot) {
  botName        = bot.identity.name;
  requestRestart = false;

  //get users list
  bot.api.users.list({}, function(err, res) {
    if (err) {
      bot.botkit.log('Failed to retrieve list of users in team.', err);
      return;
    }
    teamUsers = res.members;
  });

  //gets channel id
  bot.api.groups.list({}, function(err, res) {
    if (err) {
      bot.botkit.log('Failed to retrieve list of groups.', err);
      return;
    }

    var groups = res.groups;
    groups.forEach(function(group) {
      if (group.name === process.env.channel) {
        channelId = group.id;
      }
    });

    if (!channelId) {
      bot.botkit.log('Could not find channel id for channel ' + process.env.channel);
      return;
    }

    // gets users in channel
    bot.api.groups.info({
      channel: channelId
    }, function(err, res) {
      if (err) {
          bot.botkit.log('Failed to retrieve group info.', err);
          return;
      }

      channelInfo = res.group;
      var memberIds = channelInfo.members;
      channelUserNamesAll = [];

      memberIds.forEach(function(memberId){
        teamUsers.forEach(function(teamUser) {
          if (teamUser.id === memberId) {
            if (teamUser.profile.real_name.length > 0 && bannedUsers.indexOf(teamUser.profile.real_name) <= -1) {
              channelUserNamesAll.push({
                name: teamUser.profile.real_name,
                username: teamUser.name.toLowerCase(),
                id: teamUser.id.toLowerCase(),
                prCount: 0
              });
            }
          }
        });
      });

      // welcome!
      say('Hello! My name is ' + botName + ' :charmander::sunny:', bot);

      // activate resets
      resetController(bot);
    });
  });
}


/**
 * DIRECT MENTION FUNCTIONALITY
 * - help
 * - restart
 * - reset pr
 * - reset
 * - ls -a
 * - ls
 * - increment / decrement
 * - review
 * - no
 * - remove
 * - add
 * - greetings (hi, hello, hey)
 */

// reply to a direct mention - @bot hello
controller.on('direct_mention',function(bot, message) {
  var requestUserId = message.user.toLowerCase();
  var requestUserName;
  var requestUserNameString;
  var messageContent = message.text.toLowerCase();
  var messageArray = messageContent.split(' ');
  var command;
  var links = [];

  if (messageArray.length >= 1) {
    command = messageArray[0];
    for (var i = 1; i < messageArray.length; i++)
      links.push(messageArray[i]);
  }
  var channelUserNames = channelUserNamesCurrent.slice();

  /* list all possible options */
  if (command && command === 'help') {
    bot.reply(message, helpMessage());
  }

  /* restart */
  else if (command && command === 'restart') {
    requestRestart = true;
    bot.reply(message, 'Are you sure you\'d like to restart? All user data will be reset (@' + botName + ' yes/no)');
  }

  /* verify restart: yes */
  else if (command && command === 'yes' && requestRestart) {
    requestRestart = false;
    bot.reply(message, 'Restarting...see ya in a sec!');
    setTimeout( function() {
      boot(bot);
    }, 1000);
  }

  /* verify restart: no */
  else if (command && command === 'no' && requestRestart) {
    requestRestart = false;
    bot.reply(message, 'Okay, I will not restart');
  }

  /* restore pr counts */
  else if (command && contains(messageContent, ['reset pr', 'pr reset'])) {
    bot.reply(message, resetPRCount());
  }

  /* restore original users */
  else if (command && command === 'reset') {
    bot.reply(message, restoreUsers());
  }

  /* print all users */
  else if (command && contains(messageContent, ['ls -a'])) {
    bot.reply(message, printAll());
  }

  /* print all current users */
  else if (command && command === 'ls') {
    bot.reply(message, printCurrent());
  }

  /* increment/decrement PR count for an user */
  else if (command && contains(command, ['++', '--'])) {
    bot.reply(message, updatePRCount(command)); //updatePRCount returns any success/error messages
  }

  /* pick someone to review code */
  else if (command && links.length > 0 && command === 'review') {
    // remove self
    removeUser(requestUserId, channelUserNames);

    // no other reviewers
    if (!channelUserNames.length) {
      bot.reply(message, noReviewersError());
      return;
    }

    //determine users that have had the fewest review requests so far
    var low = 100,
      high = 0,
      user,
      prCount;
    for (var i in channelUserNames) {
      user = channelUserNames[i];
      prCount = user.prCount;
      if (prCount < low) {
          low = prCount;
      }
      if (prCount > high) {
          high = prCount;
      }
    }
    if (low != high) {
      for (var i in channelUserNames) {
        user = channelUserNames[i];
        prCount = user.prCount;
        if (prCount > low) {
          // remove from the list
          channelUserNames.splice(i, 1);
        }
      }
    }

    requestUserNameString = requestUserName ? requestUserName + '\'s' : 'this';

    var randomnumber = Math.floor(Math.random() * (channelUserNames.length));
    var selectedUser = channelUserNames[randomnumber];

    selectedUser.prCount++;
    bot.reply(message, 'Hey <@' + selectedUser.username + '> (Review count: ' + selectedUser.prCount + ') please review ' + requestUserNameString + ' code: ' + concatLinks(links));

    // update
    prev = {};
    prev.links = links;
    prev.selectedUser = selectedUser;
    prev.requestUserNameString = requestUserNameString;
    prev.requestUserId = requestUserId;
  }

  /* pick someone else to review code */

  else if (command && channelUserNames && prev && command === 'no') {

    // remove previous user from active duty
    removeUser(prev.selectedUser.id, channelUserNamesCurrent);
    channelUserNames = channelUserNamesCurrent.slice();

    // remove self
    removeUser(prev.requestUserId, channelUserNames);

    // decrease previous user prCount and relieve them of reviewing duty
    prev.selectedUser.prCount--;
    bot.reply(message, 'I messed up. Sorry, ' + getUsername(prev.selectedUser) + '! :see_no_evil: I\'ve temporarily relieved you from code review duties.');

    // no other reviewers
    if (!channelUserNames.length) {
      bot.reply(message, noReviewersError());
      return;
    }

    // other reviewers exist
    // select a new user
    var randomnumber = Math.floor(Math.random() * (channelUserNames.length));
    var selectedUser = channelUserNames[randomnumber];
    selectedUser.prCount++;
    bot.reply(message, 'Hey <@' + selectedUser.username + '> (Review count: ' + selectedUser.prCount + ') please review ' + prev.requestUserNameString + ' code: ' + concatLinks(prev.links));

    // update prev
    prev.selectedUser = selectedUser;
  }

  /* remove an user from active duty */
  else if (command && links.length > 0 && command === 'remove') {

    var name = stripUser(links[0]);
    var user = find(name, channelUserNamesCurrent);

    // remove
    if (user) {
      removeUser(user.id, channelUserNamesCurrent);
      bot.reply(message, 'Got it! I will not ask ' + getUsername(user) + ' to review code.\nYou can re-add any user by saying `@' + botName + ' add @<user>`');
      return;
    }

    // already inactive
    user = find(name, channelUserNamesAll);
    if (user) {
      bot.reply(message, userNotActiveError(user, 'Did you mean to remove a different user?'));
      return;
    }

    // user not found
    bot.reply(message, userNotFoundError());
  }

  /* add an user to active duty */
  else if (command && links.length > 0 && command === 'add') {

    var name = stripUser(links[0]);
    var user = find(name, channelUserNamesAll);

    // user not found
    if (user === 0) {
      bot.reply(message, userNotFoundError());
      return;
    }

    // user already active
    if (find(name, channelUserNamesCurrent)) {
      bot.reply(message, userActiveError(user, 'You can say `@' + botName + ' ls` to view all active users'));
      return;
    }

    // add
    addUser(user, channelUserNamesCurrent);
    bot.reply(message, 'Got it! My magic box will now include ' + getUsername(user) + ' when it picks someone to review code');
  }

  /* greetings */
  else if (command && contains(messageContent, ['hi', 'hello', 'hey'])) {
    var greetings = [
      '\'Sup homeslice?',
      'What do you want? <(ಠ_ಠ)>',
      'Howdy howdy howdy',
      'I like your face.',
      'How do you comfort a JavaScript bug? You console it.'
    ];

    var randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    bot.reply(message, randomGreeting);
  }

  /** error!
    * - print error msg (with most recently used link, if available)
    * - if user tries to retract with no prev entry, warning + generic error
    * - generic error message
    */

  else if (command && !prev && command === 'no') {
    bot.reply(message, 'I didn\'t do anything yet!');
    bot.reply(message, 'Try `@' + botName + ' review <link>`');
  }
  else if (contains(messageContent, ['stop', 'devolve', 'shut up', 'shush', 'ugh', 'be quiet', 'drop', 'kill', 'no', 'stupid', 'dumb', 'quit', 'bad'])) {
    bot.reply(message, ':white_frowning_face: I\'m trying my best!');
  }
  else {
    bot.reply(message, 'Sorry, I didn\'t get that. I\'m a bot, so sometimes I have trouble parsing words! :see_no_evil:');
    bot.reply(message, 'To see a list of everything I can do, say `help`');
  }

  return;
});


/**
 * DIRECT MESSAGE FUNCTIONALITY
 * - help
 * - greetings (hi, hello, hey)
 * - list users (all users, active/current users)
 */

// reply to a direct message
controller.on('direct_message',function(bot,message) {
  messageContent = message.text;
  if (!messageContent) {
    bot.reply(message,'Hmm..I didn\'t catch that');
    return;
  }
  // reply to _message_ by using the _bot_ object
  if (contains(messageContent, ['help', 'can you'])) {
    bot.reply(message, helpMessage());
  } else if (contains(messageContent, ['hi', 'hello', 'hey'])) {
    bot.reply(message, 'Howdy! To see a list of everything I can do, say `help`.');
  } else if (contains(messageContent, ['all', 'user'])) {
    bot.reply(message, printAll());
  } else if (contains(messageContent, ['user', 'active user', 'current user'])) {
    bot.reply(message, printCurrent());
  } else {
    bot.reply(message, 'Sorry, I didn\'t get that. I\'m a bot, so sometimes I have trouble parsing words!');
    bot.reply(message, 'To see a list of everything I can do, say `help`');
  }
});


/**
 * USER HELPERS
 * - addUser
 * - removeUser
 * - restoreUsers
 * - getUsername
 * - find (findById, findByUsername)
 * - incrementCount
 * - decrementCount
 * - updatePRCount
 * - resetPRCount
 */

/* add user to list */
function addUser(s, l) {
  l.push(s);
}

/* remove from list by id */
function removeUser(s, l) {
  for (var i in l) {
    if (l[i].id == s) {
      l.splice(i, 1);
      break;
    }
  }
}

/* restore all users to active */
function restoreUsers() {
  channelUserNamesCurrent = channelUserNamesAll.slice();
  return 'All users have been restored!\n' + printCurrent();
}

/* get a user's username */
function getUsername(user) {
  return user.name.split(' ')[0];
}

/* find a user */
function find(s, l) {
  return findById(s, l) || findByUsername(s, l);
}

/* find a user by id */
function findById(s, l) {
  for (var i in l) {
    if (l[i].id == s) {
      return l[i];
    }
  }
  return 0;
}

/* find a user by username */
function findByUsername(s, l) {
  for (var i in l) {
    if (l[i].username == s) {
      return l[i];
    }
  }
  return 0;
}

/* increases a user's PR count */
function incrementCount(user) {
  user.prCount++;
}

/* decreases a user's PR count */
function decrementCount(user) {
  if (user.prCount > 0) {
    user.prCount--;
    return true;
  }
  return false;
}

/* increment/decrement a user's PR count */
function updatePRCount(command) {
  // determine if we're incrementing or decrementing
  var operator;
  if (contains(command, ['++']))
    operator = '++';
  else if (contains(command, ['--']))
    operator = '--';
  else {
    return 'Hmm, something went wrong'
  }

  // find user
  var name            = stripUser(command.replace(operator, '')),
      user            = find(name, channelUserNamesCurrent),
      userToIncrement = find(name, channelUserNamesAll);

  // user is active, increment/decrement
  if (user && userToIncrement) {
    if (operator == '++')
      incrementCount(userToIncrement);
    else
      if (!decrementCount(userToIncrement))
        return getUsername(user) + ' already has a PR count of ' + user.prCount + '!';
    return 'Success! ' + getUsername(user) + ' now has a PR count of ' + user.prCount;
  }

  // user is not active
  if (userToIncrement)
      return userNotActiveError(userToIncrement, 'You can only ' + operator + ' the PR count of active users');

  // error: no user found
  return userNotFoundError();
}

/* reset the PR count for all users */
function resetPRCount() {
  channelUserNamesAll.map(function(user) {
    return user.prCount = 0;
  })
  return 'All PR counts have been reset!\n' + printCurrent();
}


/**
 * GENERAL HELPERS
 * - stripUser, stripLink
 * - concatLinks
 * - contains
 */

/* strip an user id */
function stripUser(s) {
  return s.replace('@', '').replace('<', '').replace('>', '');
}

/* strip a link */
function stripLink(s) {
  return s.replace(/</g, '').replace(/>/g, '').replace(/`/g, '');
}

/* concatenate a message */
function concatLinks(l) {
  var o = "";
  for (var i in l) {
    o += stripLink(l[i]) + " "
  }
  return o;
}

/* check if a string contains any of the elements in an array */
function contains(s, l) {
  for (i in l) {
    if (s.indexOf(l[i]) > -1) {
      return true;
    }
  }
  return false;
}

/**
 * GENERAL MESSAGING
 * - printCurrent
 * - printAll
 * - helpMessage
 * - say
 */

/* return a string of all active users */
function printCurrent() {
  var o = "Here's a list of all active users:";
  for (var i in channelUserNamesCurrent) {
    var user = channelUserNamesCurrent[i];
    o += '\n- ' + user.username + ' (Review count: ' + user.prCount + ')';
  }
  return o;
}

/* return a string of all users */
function printAll() {
  var o = "Here's a list of all users in this channel:";
  for (var i in channelUserNamesAll) {
    var user = channelUserNamesAll[i];
    o += '\n- ' + user.username + ' (Review count: ' + user.prCount + ')';
  }
  return o;
}

/* return a string with all bot capabilities */
function helpMessage() {
  var o  = "Here are all the things I can do:\n";
    o += "\n*Code Review*\n";
    o += "_Pick someone to review code_\t`@" + botName + " review <link>`\n";
    o += "\n*Manage Users*\n";
    o += "_Add an user_\t\t  `@" + botName + " add <username>`\n";
    o += "_Remove an user_\t`@" + botName + " remove <username>`\n";
    o += "\n*PR Counts*\n";
    o += "_Increase an user's PR count_\t  `@" + botName + " <username>++`\n";
    o += "_Decrease an user's PR count_\t `@" + botName + " <username>--`\n";
    o += "_Reset all PR counts_\t\t\t\t\t`@" + botName + " reset pr`\n";
    o += "\n*Print Current Status*\n";
    o += "_View all active reviewers_\t\t\t`@" + botName + " ls`\n";
    o += "_View all users in this channel_\t `@" + botName + " ls -a`\n";
    o += "\n*Reset*\n";
    o += "_Set all users to active_\t`@" + botName + " reset`\n";
    o += "_Restart_\t\t\t\t\t\t  `@" + botName + " restart`\n";
    o += "\nI restore all users every weekday morning at 9am, and ";
    o += "reset PR counts to 0 every Monday at 9am";
  return o;
}

/* wrapper for slack's bot.say */
function say(msg, bot) {
  bot.say({
    text: msg,
    channel: channelId
  })
}


/**
 * ERROR MESSAGING
 * - userNotFoundError
 * - userNotActiveError
 * - userActiveError
 */

function userNotFoundError() {
  return 'Hmm...I couldn\'t find a human by that name.\nTry `@' + botName + ' ls` to view all users in this channel'
}

function userNotActiveError(user, message) {
  var err = 'Hmm...looks like ' + getUsername(user) + ' is not active.';
  if (message)
    err += '\n' + message;
  return err;
}

function userActiveError(user, message) {
  var err = 'Hmm...looks like ' + getUsername(user) + ' is already active.';
  if (message)
    err += '\n' + message;
  return err;
}

function noReviewersError() {
  prev = null;
  return 'There are no active users who can review your code! :vince::confounded:\n' +
         'You can view all users in this channel by saying `@' + botName + ' ls -a` ' +
         'and add any user by saying `@' + botName + ' add @<user>`';
}
