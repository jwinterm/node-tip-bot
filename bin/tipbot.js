var irc    = require('irc'),
  winston  = require('winston'),
  fs       = require('fs'),
//  http     = require('http'),
//  https    = require('https'),
//  http     = require('follow-redirects').http,
//  https    = require('follow-redirects').https,
  request  = require('request'),
  yaml     = require('js-yaml'),
  coin     = require('node-dogecoin'),
  webadmin = require('../lib/webadmin/app');

// check if the config file exists
if(!fs.existsSync('./config/config.yml')) {
  winston.error('Configuration file doesn\'t exist! Please read the README.md file first.');
  process.exit(1);
}

// handle sigint
process.on('exit', function() {
  winston.info('Exiting...');
  if(client != null) {
    client.disconnect('My master ordered me to leave.');
  }
});

// load settings
var settings = yaml.load(fs.readFileSync('./config/config.yml', 'utf-8'));

// load winston's cli defaults
winston.cli();

// write logs to file
if(settings.log.file) {
  winston.add(winston.transports.File, {
    filename: settings.log.file, 
    level: 'debug'});
}

// connect to coin json-rpc
winston.info('Connecting to coind...');

var coin = coin({
  host: settings.rpc.host,
  port: settings.rpc.port,
  user: settings.rpc.user,
  pass: settings.rpc.pass
});

coin.getBalance(function(err, balance) {
  if(err) {
    winston.error('Could not connect to %s RPC API! ', settings.coin.full_name, err);
    process.exit(1);
    return;
  }

  var balance = typeof(balance) == 'object' ? balance.result : balance;
  winston.info('Connected to JSON RPC API. Current total balance is %d' + settings.coin.short_name, balance);
})

// run webadmin
if(settings.webadmin.enabled)
{
  winston.info('Running webadmin on port %d', settings.webadmin.port);
  webadmin.app(settings.webadmin.port, coin, settings, winston);
}

// connect to the server
winston.info('Connecting to the server...');

var client = new irc.Client(settings.connection.host, settings.login.nickname, {
  port:   settings.connection.port, 
  secure: settings.connection.secure, 

  userName: settings.login.username,
  realName: settings.login.realname,

  debug: settings.connection.debug
});

// gets user's login status
irc.Client.prototype.isIdentified = function(nickname, callback) {
  // request login status
  this.say('NickServ', 'ACC ' + nickname);

  // wait for response
  var listener = function(from, to, message) {
   // proceed only on NickServ's ACC response
    var regexp = new RegExp('^(\\S+) ACC (\\d)');
    if(from != undefined && from.toLowerCase() == 'nickserv' && regexp.test(message)) {
      var match = message.match(regexp);
      var user  = match[1];
      var level = match[2];

      // if the right response, call the callback and remove this listener
      if(user.toLowerCase() == nickname.toLowerCase()) {
        callback(level == 3);
        this.removeListener('notice', listener);
      }
    }
  }

  this.addListener('notice', listener);
}

irc.Client.prototype.getNames = function(channel, callback) {
  client.send('NAMES', channel);
  var listener = function(nicks) {
    var names = [];
    for(name in nicks) {
      names.push(name);
    }
    callback(names);
    this.removeListener('names' + channel, listener);
  }

  this.addListener('names' + channel, listener);
}

irc.Client.prototype.getAddress = function(nickname, callback) {
  winston.debug('Requesting address for %s', nickname);
  coin.send('getaccountaddress', settings.rpc.prefix + nickname.toLowerCase(), function(err, address) {
    if(err) {
      winston.error('Something went wrong while getting address. ' + err);
      callback(err);

      return false;
    }

    callback(false, address);
  });
}

String.prototype.expand = function(values) {
  var global = {
    nick: client.nick
  }
  return this.replace(/%([a-zA-Z_]+)%/g, function(str, variable) {
    return typeof(values[variable]) == 'undefined' ? 
      (typeof(settings.coin[variable]) == 'undefined' ? 
        (typeof(global[variable]) == 'undefined' ?
          str : global[variable]) : settings.coin[variable]) : values[variable];
  });
}

// basic handlers
client.addListener('registered', function(message) {
  winston.info('Connected to %s.', message.server);

  client.say('NickServ', 'IDENTIFY ' + settings.login.nickserv_password);
});

client.addListener('error', function(message) {
  winston.error('Received an error from IRC network: ', message);
});


function escapeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&laquo;/g, "<<")
    .replace(/&raquo;/g, ">>")
}

var urlRegExp = new RegExp("https?://[a-z0-9\\.\\-]+(\\S*)");
var titleRegExp = new RegExp("<title[^>]*>([^]+?)</title>", "i");
client.addListener('message', function(from, channel, message) {
  //Check urls and say title
  if(urlRegExp.test(message)) {
    var url = urlRegExp.exec(message)[0]; 
    request(url, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        // console.log(body);
        var match = titleRegExp.exec(body);
        if(match && match[1]){
          client.say(channel, 'Title: ' + escapeHtml(match[1].trim()));
        }
      } else {
        client.say(channel, 'Error finding URL');
      }
    });
  }
});


var last_active = {};
var locks       = {};
var inGame      = [];

client.addListener('message', function(from, channel, message) {
  last_active[from] = Date.now();
  var match = message.match(/^(!?)(\S+)/);
  if(match == null) return;
  var prefix  = match[1];
  var command = match[2];


  if(settings.commands[command]) {
    if(channel == client.nick && settings.commands[command].pm === false) return;
    if(channel != client.nick && (settings.commands[command].channel === false || prefix != '!')) return;
  } else {
    return;
  }


  // if pms, make sure to respond to pms instead to itself
  if(channel == client.nick) channel = from;

  // comands that don't require identifying
  if(command == 'help' || command == 'terms') {
    var msg = [];
    for(var i = 0; i < settings.messages[command].length; i++) {
      client.say(from, settings.messages[command][i].expand({}));
    }
    return;
  }

  // if not that, message will be undefined for some reason
  // todo: find a fix for that
  var msg = message;
  
  var balance;
  var botBalance;
  
  coin.getBalance(settings.rpc.prefix + settings.login.nickname, settings.coin.min_confirmations, function(err, balance) {
      if(err) {
        locks[from.toLowerCase()] = null;          
        winston.error('Error in !tip command.', err);
        client.say(channel, settings.messages.error.expand({name: from}));
        return;
      }
      if (balance) {
        botBalance = typeof(balance) == 'object' ? balance.result : balance;
        // console.log(botBalance);
      }
  })

  client.isIdentified(from, function(status) {
    var message = msg;
    // check user balance up front
    coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
      if(err) {
        locks[from.toLowerCase()] = null;          
        winston.error('Error in !tip command.', err);
        client.say(channel, settings.messages.error.expand({name: from}));
        return;
      }
      if (balance) {
        balance = typeof(balance) == 'object' ? balance.result : balance;
        // console.log(balance);
      }
    })
      
    // check if the sending user is logged in (identified) with nickserv
    if(!status) {
      winston.info('%s tried to use command `%s`, but is not identified.', from, message);
      client.say(channel, settings.messages.not_identified.expand({name: from}));
      return;
    }

    // console.log(balance);
    // console.log(locks);
    
    switch(command) {
        
      case 'rain':
        var match = message.match(/^.?rain (random)?([\d\.]+) ?(\d+)?/);
        if(match == null || !match[2]) {
          client.say(channel, 'Usage: !rain <amount> [max people]');
          return;
        }

        var random = match[1];
        var amount = Number(match[2]);
        var max    = Number(match[3]);

        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[2]}));
          return;
        }

        if(random) {
          var min = settings.coin.min_rain;
          var maxAmount = amount;
          amount  = Math.floor(Math.random() * (maxAmount - min + 1)) + min;
        }

        if(isNaN(max) || max < 1) {
          max = false;
        } else {
          max = Math.floor(max);
        }

        // lock
        if(locks.hasOwnProperty(from.toLowerCase()) && locks[from.toLowerCase()]) return;
        locks[from.toLowerCase()] = true;

        coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            locks[from.toLowerCase()] = null;
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            client.getNames(channel, function(names) {
              // rain only on nicknames active within the last x seconds
              if(settings.commands.rain.rain_on_last_active) {
                for (var i = names.length - 1; i >= 0; i--) {
                  if(!last_active.hasOwnProperty(names[i]) || last_active[names[i]] + settings.commands.rain.rain_on_last_active * 1000 < Date.now()) {
                    names.splice(i, 1);
                  }
                };
              }
              // remove tipper from the list
              names.splice(names.indexOf(from), 1);
              // shuffle the array
              for(var j, x, i = names.length; i; j = Math.floor(Math.random() * i), x = names[--i], names[i] = names[j], names[j] = x);

              max = max ? Math.min(max, names.length) : names.length;
              if(max == 0) return;
              var whole_channel = false;
              if(max == names.length) whole_channel = true;
              names = names.slice(0, max);

              if(amount / max < settings.coin.min_rain) {
                locks[from.toLowerCase()] = null;
                client.say(channel, settings.messages.rain_too_small.expand({from: from, amount: amount, min_rain: settings.coin.min_rain * max}));
                return;
              }

              for (var i = 0; i < names.length; i++) {
                coin.move(settings.rpc.prefix + from.toLowerCase(), settings.rpc.prefix + names[i].toLowerCase(), amount / max, function(err, reply) {
                  if(i == names.length) locks[from.toLowerCase()] = null;
                  if(err || !reply) {
                    winston.error('Error in !tip command', err);
                    return;
                  }
                });
              }

              client.say(channel, settings.messages.rain.expand({name: from, amount: parseFloat((amount / max).toFixed(8)), list: (whole_channel && !settings.commands.rain.rain_on_last_active) ? 'the whole channel' : names.join(', ')}));
            });
          } else {
            locks[from.toLowerCase()] = null;
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        })
        break;
        
        
      case 'rainall':
        var match = message.match(/^.?rainall (random)?([\d\.]+)/);
        if(match == null || !match[2]) {
          client.say(channel, 'Usage: !rainall <amount>');
          return;
        }

        var random = match[1];
        var amount = Number(match[2]);

        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[2]}));
          return;
        }

        if(random) {
          var min = settings.coin.min_rain;
          var maxAmount = amount;
          amount  = Math.floor(Math.random() * (maxAmount - min + 1)) + min;
        }

        if(isNaN(max) || max < 1) {
          max = false;
        } else {
          max = Math.floor(max);
        }
        
        // lock
        if(locks.hasOwnProperty(from.toLowerCase()) && locks[from.toLowerCase()]) return;
        locks[from.toLowerCase()] = true;
        
        coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            locks[from.toLowerCase()] = null;
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            client.getNames(channel, function(names) {
              names.splice(names.indexOf(from), 1);
              names.splice(names.indexOf(settings.login.nickname), 1);
              // shuffle the array
              for(var j, x, i = names.length; i; j = Math.floor(Math.random() * i), x = names[--i], names[i] = names[j], names[j] = x);

              max = max ? Math.min(max, names.length) : names.length;
              if(max == 0) return;
              var whole_channel = false;
              if(max == names.length) whole_channel = true;
              names = names.slice(0, max);

              if(amount / max < settings.coin.min_rain) {
                locks[from.toLowerCase()] = null;
                client.say(channel, settings.messages.rain_too_small.expand({from: from, amount: amount, min_rain: settings.coin.min_rain * max}));
                return;
              }

              for (var i = 0; i < names.length; i++) {
                coin.move(settings.rpc.prefix + from.toLowerCase(), settings.rpc.prefix + names[i].toLowerCase(), amount / max, function(err, reply) {
                  if(i == names.length) locks[from.toLowerCase()] = null;
                  if(err || !reply) {
                    winston.error('Error in !tip command', err);
                    return;
                  }
                });
              }

              client.say(channel, settings.messages.rain.expand({name: from, amount: amount / max, list: (whole_channel && !settings.commands.rain.rain_on_last_active) ? 'the whole channel' : names.join(', ')}));
            });
          } else {
            locks[from.toLowerCase()] = null;
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        })
        break;
        
        
      case 'tip':
        var match = message.match(/^.?tip (\S+) (random)?([\d\.]+)/);
        if(match == null || match.length < 3) {
          client.say(channel, 'Usage: !tip <nickname> <amount>')
          return;
        }
        var to     = match[1];
        var random = match[2];
        var amount = Number(match[3]);

        // lock
        if(locks.hasOwnProperty(from.toLowerCase()) && locks[from.toLowerCase()]) return;
        locks[from.toLowerCase()] = true;        
        
        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[3]}));
          return;
        }

        if(random) {
          var min = settings.coin.min_tip;
          var max = amount;
          amount  = Math.floor(Math.random() * (max - min + 1)) + min;
        }

        if(to.toLowerCase() == from.toLowerCase()) {
          locks[from.toLowerCase()] = null;
          client.say(channel, settings.messages.tip_self.expand({name: from}));
          return;
        }

        if(amount < settings.coin.min_tip) {
          locks[from.toLowerCase()] = null;
          client.say(channel, settings.messages.tip_too_small.expand({from: from, to: to, amount: amount}));
          return;
        }
        // check balance with min. 5 confirmations
        coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            locks[from.toLowerCase()] = null;
            winston.error('Error in !tip command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            coin.send('move', settings.rpc.prefix + from.toLowerCase(), settings.rpc.prefix + to.toLowerCase(), amount, function(err, reply) {
              locks[from.toLowerCase()] = null;
              if(err || !reply) {
                winston.error('Error in !tip command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }

              winston.info('%s tipped %s %d %s', from, to, amount, settings.coin.short_name)
              client.say(channel, settings.messages.tipped.expand({from: from, to: to, amount: amount}));
            });
          } else {
            locks[from.toLowerCase()] = null;
            winston.info('%s tried to tip %s %d, but has only %d', from, to, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        });
        break;
        
        
      case 'address':
        var user = from.toLowerCase();
        client.getAddress(user, function(err, address) {
          if(err) {
            winston.error('Error in !address command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          client.say(channel, settings.messages.deposit_address.expand({name: user, address: address}));
        });
        break;
        
        
      case 'balance':
        var user = from.toLowerCase();
        coin.getBalance(settings.rpc.prefix + user, settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            winston.error('Error in !balance command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          var balance = typeof(balance) == 'object' ? balance.result : balance;

          coin.getBalance(settings.rpc.prefix + user, 0, function(err, unconfirmed_balance) {
          if(err) {
              winston.error('Error in !balance command', err);
              client.say(channel, settings.messages.balance.expand({balance: balance, name: user}));
              return;
            }

            var unconfirmed_balance = typeof(unconfirmed_balance) == 'object' ? unconfirmed_balance.result : unconfirmed_balance;

            client.say(channel, settings.messages.balance_unconfirmed.expand({balance: balance, name: user, unconfirmed: unconfirmed_balance - balance}));
          })
        });
        break;
        

      case 'dice':
        var match = message.match(/^.?dice ([\d\.]+) ?(10|5|2)?/);
        if(match == null || !match[1]) {
          client.say(channel, 'Usage: !dice <amount> [multiplier]\nmultiplier should be either 2, 5, or 10 (default 2)');
          return;
        }
        // console.log(match);
        // console.log(match[1]);
        // console.log(match[2]);
        // console.log("Bot balance is: " + botBalance);
        
        var maxBet = Math.floor(0.01*botBalance);
        
        var amount = Number(match[1]);
        if (Number(match[2])) {
            var multiplier = Number(match[2]);
        } else {
            var multiplier = 2;
        }

        if(isNaN(amount)) {
          client.say(channel, settings.messages.invalid_amount.expand({name: from, amount: match[2]}));
          return;
        }

        if(amount > maxBet) {
          client.say(channel, "Max bet is " + maxBet + ' ' + settings.coin.short_name);
          return;
        }
        
        // lock
        if(locks.hasOwnProperty(from.toLowerCase()) && locks[from.toLowerCase()]) return;
        locks[from.toLowerCase()] = true;
        
        coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
          if(err) {
            locks[from.toLowerCase()] = null;          
            winston.error('Error in !dice command.', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }
          var balance = typeof(balance) == 'object' ? balance.result : balance;

          if(balance >= amount) {
            console.log(amount, multiplier);
            var roll = Math.random();
            
            if (roll < (1/multiplier - 0.01)) {
              if (multiplier == 2) {
                  var winnings = amount;
              } else {
                  var winnings = amount*multiplier;
              }
              coin.send('move', settings.rpc.prefix + settings.login.nickname, settings.rpc.prefix + from.toLowerCase(), winnings, function(err, reply) {
              locks[from.toLowerCase()] = null;
              if(err || !reply) {
                winston.error('Error in !dice command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }

              winston.info('%s transferred %s %d %s', settings.login.nickname, from, winnings, settings.coin.short_name)
              client.say(channel, from + ' rolled ' + Number(roll).toFixed(4) + ' on target of ' + Number(1/multiplier - 0.01).toFixed(2) + '...win ' + winnings + ' ' + settings.coin.short_name + ' !');
              });
            }
            
            else {
              coin.send('move', settings.rpc.prefix + settings.rpc.prefix + from.toLowerCase(), settings.login.nickname, amount, function(err, reply) {
              locks[from.toLowerCase()] = null;
              if(err || !reply) {
                winston.error('Error in !dice command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }

              winston.info('%s transferred %s %d %s', from, settings.login.nickname, amount, settings.coin.short_name)
              client.say(channel, from + " rolled " + Number(roll).toFixed(4) + " on target of " + Number(1/multiplier - 0.01).toFixed(2) + "...lose " + amount + " MYR!"); 
              });
            }
          }  
          else {
            locks[from.toLowerCase()] = null;
            winston.info('%s tried to roll %d, but has only %d', from, amount, balance);
            client.say(channel, settings.messages.no_funds.expand({name: from, balance: balance, short: amount - balance, amount: amount}));
          }
        })
        break;        
        

      case 'housebalance':
        var match = message.match(/^.?housebalance/);
        client.say(channel, 'The houses\'s balance is currently: ' + botBalance + ' MYR');
        break;


      case 'maxbet':
        var match = message.match(/^.?maxbet/);
        client.say(channel, 'The maximum bet (1% of house balance) is currently: ' + Math.floor(0.01*botBalance) + ' MYR');
        break;
      

      case 'network':
        var match = message.match(/^.?network/);
        
        coin.getmininginfo(function() {
            mininginfo = arguments['1'];
            
            client.say(channel, 'The current block height is: ' + mininginfo.blocks + '\nThe current diff / hashrates are:\nSha256: ' + Number(mininginfo.difficulty_sha256d).toFixed(3) + ' / ' + Number(mininginfo.difficulty_sha256d * 28873239.4366 / 1e12).toFixed(3) + ' Th/s\nScrypt: ' + Number(mininginfo.difficulty_scrypt).toFixed(3) + ' / ' + Number(mininginfo.difficulty_scrypt * 28873239.4366 / 1e9).toFixed(3) + ' Gh/s\nGroestl: ' + Number(mininginfo.difficulty_groestl).toFixed(3) + ' / ' + Number(mininginfo.difficulty_groestl * 28873239.4366 / 1e9).toFixed(3) + ' Gh/s\nSkein: ' + Number(mininginfo.difficulty_skein).toFixed(3) + ' / ' + Number(mininginfo.difficulty_skein * 28873239.4366 / 1e9).toFixed(3) + ' Gh/s\nQubit: ' + Number(mininginfo.difficulty_qubit).toFixed(3) + ' / ' + Number(mininginfo.difficulty_qubit * 28873239.4366 / 1e9).toFixed(3) + ' Gh/s');
            
            // lastblock = mininginfo.blocks;
            // coin.getblockhash(function(lastblock) {
                // lasttx = arguments['1'];
                // coin.getblock(function(lasttx) {
                    // lastalgo = arguments['1'];
                    // client.say(channel, 'Block ' + lastblock + ' was solved by ' + lastalgo + 'algo.');
                // })
            // })            
        });
        break;
      
      case 'price':
        var polourl = 'https://poloniex.com/public?command=returnTicker';
        var cryptsyurl = 'http://pubapi.cryptsy.com/api.php?method=singlemarketdata&marketid=200';
        var bittrexurl = 'https://bittrex.com/api/v1.1/public/getmarketsummary?market=btc-myr';

        var poloprice;
        var cryptsyprice;
        var bittrexprice;

        function getPoloPrice(callback) {
          request(polourl, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                poloprice = JSON.parse(body).BTC_MYR.last;
             }
              else {poloprice = 0.0;}
             poloCallback();
          });
        }
        function poloCallback() {
            client.say(channel, "Poloniex price: " + Number(poloprice).toFixed(8) + " BTC/MYR");
        }

        function getCryptsyPrice(callback) {
          request(cryptsyurl, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                cryptsyprice = JSON.parse(body).return.markets.MYR.lasttradeprice;
             }
              else {cryptsyprice = 0.0;}
             cryptsyCallback();
          });
        }
        function cryptsyCallback() {
            client.say(channel, "Crypsty price:  "  + Number(cryptsyprice).toFixed(8) + " BTC/MYR" );
        }

        function getBittrexPrice(callback) {
          request(bittrexurl, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                bittrexprice = JSON.parse(body).result[0]["Last"];
             }
              else {bittrexprice = 0.0;}
             bittrexCallback();
          });
        }
        function bittrexCallback() {
            client.say(channel, "Bittrex price:  "  + Number(bittrexprice).toFixed(8) + " BTC/MYR");
        }

        function getPrices() {
            getPoloPrice(poloCallback);
            getCryptsyPrice(cryptsyCallback);
            getBittrexPrice(bittrexCallback);
        }
        getPrices();
        break;
      
      case 'withdraw':
        var match = message.match(/^.?withdraw (\S+)$/);
        if(match == null) {
          client.say(channel, 'Usage: !withdraw <' + settings.coin.full_name + ' address>');
          return;
        }
        var address = match[1];

        coin.validateAddress(address, function(err, reply) {
          if(err) {
            winston.error('Error in !withdraw command', err);
            client.say(channel, settings.messages.error.expand({name: from}));
            return;
          }

          if(reply.isvalid) {
            coin.getBalance(settings.rpc.prefix + from.toLowerCase(), settings.coin.min_confirmations, function(err, balance) {
              if(err) {
                winston.error('Error in !withdraw command', err);
                client.say(channel, settings.messages.error.expand({name: from}));
                return;
              }
              var balance = typeof(balance) == 'object' ? balance.result : balance;

              if(balance < settings.coin.min_withdraw) {
                winston.warn('%s tried to withdraw %d, but min is set to %d', from, balance, settings.coin.min_withdraw);
                client.say(channel, settings.messages.withdraw_too_small.expand({name: from, balance: balance}));
                return;
              }

              coin.sendFrom(settings.rpc.prefix + from.toLowerCase(), address, balance - settings.coin.withdrawal_fee, function(err, reply) {
                if(err) {
                  winston.error('Error in !withdraw command', err);
                  client.say(channel, settings.messages.error.expand({name: from}));
                  return;
                }

                var values = {name: from, address: address, balance: balance, amount: balance - settings.coin.withdrawal_fee, transaction: reply}
                for(var i = 0; i < settings.messages.withdraw_success.length; i++) {
                  var msg = settings.messages.withdraw_success[i];
                  client.say(channel, msg.expand(values));
                };

                // transfer the rest (withdrawal fee - txfee) to bots wallet
                coin.getBalance(settings.rpc.prefix + from.toLowerCase(), function(err, balance) {
                  if(err) {
                    winston.error('Something went wrong while transferring fees', err);
                    return;
                  }

                  var balance = typeof(balance) == 'object' ? balance.result : balance;

                  // moves the rest to bot's wallet
                  coin.move(settings.rpc.prefix + from.toLowerCase(), settings.rpc.prefix + settings.login.nickname.toLowerCase(), balance);
                });
              });
            });
          } else {
            winston.warn('%s tried to withdraw to an invalid address', from);
            client.say(channel, settings.messages.invalid_address.expand({address: address, name: from}));
          }
        });
        break;
    }
  });
});

client.addListener('notice', function(nick, to, text, message) {
  if(nick && nick.toLowerCase() == 'nickserv' && !text.match(/ ACC /)) {
    winston.info('%s: %s', nick, text);
    if(text.match(/^You are now identified/)) {
      for (var i = settings.channels.length - 1; i >= 0; i--) {
        client.join(settings.channels[i]);
      };
    }
  }
});
