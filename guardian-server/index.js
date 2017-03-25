'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

var express = require('express');
var app = express();
var session = require('express-session');
var Promise = require('bluebird');
var passport = require('passport');
var uberStrategy = require('passport-uber');
var info = require('./info-' + process.env.NODE_ENV + '.js');
var util = require('./util.js');
var _ = require('lodash');
var MongoStore = require('connect-mongo')(session);
var mongoose = require('mongoose');
mongoose.connect(info.MONGO_CONNECTION_STRING);

var User = require('./models/User.js');

app.set('view engine', 'hbs');
app.use(session({
  secret: info.SECRET_SESSION_KEY,
  store: new MongoStore({ mongooseConnection: mongoose.connection }),
}));
// app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

var userForiOSClient = function(req, res, next) {
  if (req.headers.authorization) {
    var uuid = req.headers.authorization.split(' ')[1];
    User.findOne({uuid: uuid}, function(err, user) {
      req.user = user;
      next();
    });
  }
};

var twilioUser = function(req, res, next) {
  if (req.query.uuid) {
    var uuid = req.query.uuid;
    User.findOne({uuid: uuid}, function(err, user) {
      req.user = user;
      next();
    });
  }
};

var compiledUberStrategy = new uberStrategy(
  {
    clientID: info.UBER_CLIENT_ID,
    clientSecret: info.UBER_CLIENT_SECRET,
    callbackURL: info.HOSTNAME + '/auth/uber/callback',
  },
  function(accessToken, refreshToken, profile, done) {
    // save shit to database
    profile.accessToken = accessToken;
    User.findOrCreate({ uuid: profile.uuid }, profile, function (err, user) {
      user.accessToken = accessToken;
      user.save();
      return done(err, user);
    });
  }
);

passport.use(compiledUberStrategy);

passport.serializeUser(function(user, done) {
  done(null, user.uuid);
});

passport.deserializeUser(function(uuid, done) {
  User.findOne({uuid: uuid}, done);
});

app.get('/', function(req, res) {
  if (req.user) {
    res.render('index', { uuid: req.user.uuid});
  } else {
    res.redirect('/login');
  }
});

app.get('/add-contact-number', userForiOSClient, function(req, res) {
  req.user.emergencyContacts = [util.formatNumber(req.query.contact)];
  req.user.save();

  res.sendStatus(200);
});

app.get('/login', function(req, res) {
  res.redirect('/auth/uber');
});

app.get('/auth/uber', passport.authenticate('uber'));

app.get('/auth/uber/callback',
  passport.authenticate('uber', {
    failureRedirect: '/',
  }), function(req, res) {
    res.redirect('/');
  }
);


app.post('/twilio',
  twilioUser,
  function(req, res) {
    res.set('Content-Type', 'text/xml');
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
          '<Say voice="alice" language="en-US">' +
            'Hi, this is ' + req.user.first_name + ' ' + req.user.last_name + '. ' +
            'I am walking to the pin. Please have your hazards on so I can easily identify your vehicle. ' +
            'I should be there in ' + Math.ceil(parseFloat(req.query.eta) / 60.0).toString() + ' minutes. ' +
            'This message is automated because I wish to stay aware of my surroundings. ' +
            'Thank you!' +
          '</Say>' +
      '</Response>'
    );
  }
);

app.get('/the-fuck-out-of-here',
  userForiOSClient,
  function(req, res) {
    var request = util.authenticatedRequest(req.user.accessToken);

    var lat = parseFloat(req.query.lat);
    var lng = parseFloat(req.query.lng);

    var speed = parseFloat(req.query.speed);
    var direction = parseFloat(req.query.direction);

    console.log('%s m/s @ %s° at %s, %s', speed, direction, lat, lng);

    // var degreeSpread = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];
    var degreeSpread = [-10, 0, 10];

    if (speed < 0.3) {
      // they were standing still, or I was testing
      speed = 1.3; // average speed of a walker, probably
      // degreeSpread = [-170, -130, -90, -60, -40, -20, 0, 20, 40, 60, 90, 130, 170];
      degreeSpread = [-10, 0, 10];
      direction = 170.0;
    }

    // 1) Get the estimated wait time from Uber
    // 2) Generate a list of lat/lng pairs around the user in increments of a few degrees
    //    and plus or minus a few m/s
    // 3) Snap those points to the nearest roads (thanks Google Maps API)
    // 4) Take each of those points and find out how long it'll take to walk there
    //    from the original location (thanks again Google)
    // 5) Find the route/location pair that most closely matches where you'll be.
    // 6) Order the Uber to that location
    // 7) Call the Uber driver and let them know what's up.
    // 8) Texts your friend to let them know you're walking to an Uber.

    Promise.resolve().bind({})
    .then(function() {
      return util.getEstimatedWaitTime(request, lat, lng);
    })
    .then(function(uberX) {
      var estimatedWaitTime = uberX.estimate;
      this.product_id = uberX.product_id;
      this.estimatedWaitTime = estimatedWaitTime;
      console.log('ESTIMATED TIME TO UBER: %s', estimatedWaitTime);

      var distancePersonCanWalkBeforeUberArrives = speed * estimatedWaitTime;
      console.log('I COULD WALK %s meters before the uber shows up.', distancePersonCanWalkBeforeUberArrives);

      var distanceScalars = [1.5, 1.0];
      var potentialDistances = _.map(distanceScalars, function(s) {
        return s * distancePersonCanWalkBeforeUberArrives;
      });

      var newLatLngs = _.flatten(_.map(potentialDistances, function(dist) {
        return _.map(degreeSpread, function(dd) {
          var rad = util.degreesToRadians(direction + dd);

          var dx = dist * Math.cos(rad);
          var dxLatitude = dx / 111073.25;

          var dy = dist * Math.sin(rad);
          var dyLongitude = dy / 82850.73;

          return {
            lat: lat + dxLatitude,
            lng: lng + dyLongitude,
          };
        });
      }));

      return newLatLngs;
    })
    .then(util.snapPointsToNearestRoads)
    .then(function(latLongs) {
      this.snapped = latLongs;
      _.each(latLongs, function(ll) {
        console.log('%s, %s', ll.lat, ll.lng);
      });
      return latLongs;
    })
    .then(function(latLongs) {
      var distancePromises = _.map(latLongs, function(pt) {
        return util.walkingDurationFromTo(lat, lng, pt.lat, pt.lng);
      });
      // var distancePromises = [util.walkingDurationFromTo(lat, lng, latLongs[0].lat, latLongs[0].lng)];
      // get walking duration to each point form lat,lng
      return Promise.all(distancePromises);
    })
    .then(function(distancesAndLegs) {
      return _.filter(distancesAndLegs, function(dl) {
        // console.log(dl[0]);
        // minimum equa distance, uber will wait a max of 2 minutes
        if ((dl[0] > this.estimatedWaitTime - 60) && (dl[0] < this.estimatedWaitTime + 180)) {
          return true;
        }
        return false;
      }.bind(this));
    })
    .then(function(distancesAndLegs) {
      return _.sortBy(distancesAndLegs, function(dl) {
        return Math.abs(dl[0] - this.estimatedWaitTime);
      }.bind(this));
    })
    .then(function(distancesAndLegs) {
      if (distancesAndLegs.length  === 0) {
        return [];
      }

      return distancesAndLegs[0][1];
    })
    .then(function(legs) {
      console.log('%s, %s', lat, lng);
      _.each(legs, function(leg) {
        _.each(leg.steps, function(step) {
          console.log('%s, %s', step.end_location.lat, step.end_location.lng);
        });
      });
      return legs;
    })
    .then(function(legs) {
      if (legs.length === 0) {
        throw 'No valid routes.';
      }

      var r = {
        preSnapped: this.preSnapped,
        snapped: this.snapped,
        legs: legs,
      };
      console.log(JSON.stringify(r));

      res.json(r);

      return legs[legs.length - 1].end_location;
    })
    .catch(function(err) {

      res.sendStatus(500);
      console.log(err.message);
      throw 'It errored already, skipping Twilio';
    })
    .then(function(coord) {
      // order the uber
      return util.orderUber(request, this.product_id, coord.lat, coord.lng);
    })
    .then(function(data) {
      // call the driver with twilio
      var driver_number = util.formatNumber(data.driver.phone_number);
      console.log(driver_number);
      return util.twilioCallDriver(driver_number, req.user, parseFloat(data.eta) * 60.0)
        .then(function() {
          return util.twilioTextFriend(req.user, parseFloat(data.eta) * 60.0);
        })
        .then(function() {
          return Promise.delay(10000).then(function() {
            return util.twilioTextFriendSafe(req.user);
          });
          return util.pollRequestForUser(request, req.user, data.request_id);
        });
    })
    .catch(function(err) {
      console.log(err);
    });
  }
);

var server = app.listen(8000, function () {
  var port = server.address().port;

  console.log('Example app listening on %s', port);
});
