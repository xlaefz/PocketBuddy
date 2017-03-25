'use strict';

var request = require('request-promise');
var _ = require('lodash');
var Promise = require('bluebird');
var info = require('./info-' + (process.env.NODE_ENV || 'development') + '.js');

var ACTUALLY_CALL_AN_UBER = false;

var twilio = require('twilio');
var client = twilio(info.TWILIO_SID, info.TWILIO_TOKEN);

var createMessage = Promise.promisify(client.messages.create);
var createCall = Promise.promisify(client.calls.create);

var UBER_API_BASE_URL = 'https://sandbox-api.uber.com';
if (ACTUALLY_CALL_AN_UBER) {
  UBER_API_BASE_URL = 'https://api.uber.com';
}

function uberDetailsPromise(request, request_id, delay) {
  return request({
    uri: UBER_API_BASE_URL + '/v1/requests/' + request_id,
  })
  .then(JSON.parse)
  .then(function(data) {
    console.log(data);
    if (data.status === 'no_drivers_available') {
      // catastrophic error lol
      console.log('No drivers available');
      throw 'No drivers available';
    }
    if (data.status === 'driver_canceled') {
      console.log('driver cancelled');
      throw 'driver cancelled';
    }

    if (data.status === 'accepted') {
      console.log(data);
      return data;
    } else {
      if (!ACTUALLY_CALL_AN_UBER) {
        putRequestStatus(request, request_id, 'accepted');
      }
      return Promise.delay(delay).then(function() {
        return uberDetailsPromise(request, request_id, delay);
      });
    }
  });
}


function uberInProgressPoll(request, request_id, delay) {
  return request({
    uri: UBER_API_BASE_URL + '/v1/requests/' + request_id,
  })
  .then(JSON.parse)
  .then(function(data) {
    console.log('pinging for in_progress...');
    if (data.status === 'in_progress') {
      return data;
    } else {
      var p = Promise.resolve();
      if (!ACTUALLY_CALL_AN_UBER) {
        p = p.then(function() {
          return Promise.delay(10000).then(function() {
            return putRequestStatus(request, request_id, 'in_progress');
          });
        });
      }
      return p.then(function() {
        return Promise.delay(delay).then(function() {
          return uberInProgressPoll(request, request_id, delay);
        });
      });
    }
  });
}

function putRequestStatus(request, request_id, status) {
  console.log('Setting request:%s to status: %s', request_id, status);
  return request({
    uri: UBER_API_BASE_URL + '/v1/sandbox/requests/' + request_id,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: status,
    }),
  });
}

function formatNumber(num) {
  return '+1' + num.replace('(', '').replace(')', '').replace('-', '').replace(' ', '');
}

function twilioTextFriendSafe(user) {
  return createMessage({
    to: user.emergencyContacts[0],
    from: info.TWILIO_NUMBER,
    body: 'Hey it\'s ' + user.first_name + ' ' + user.last_name + ', just wanted to let you know I\'m in the Uber and good to go.',
  });
}

module.exports = {
  authenticatedRequest: function(accessToken) {
    return request.defaults({
      headers: {
        'Authorization': 'Bearer ' + accessToken,
      },
    });
  },

  getEstimatedWaitTime: function(request, lat, lng) {
    return request({
      uri: UBER_API_BASE_URL + '/v1/estimates/time',
      qs: {
        start_latitude: lat,
        start_longitude: lng,
      },
    })
    .then(JSON.parse)
    .then(function(data) {
      var uberX = _.findWhere(data.times, {display_name: 'uberX'});
      if (uberX === undefined) {
        throw 'No UberX at this location';
      }

      return uberX;
    });
  },

  orderUber: function(request, product_id, start_lat, start_lng, end_lat, end_lng) {
    if (process.env.NODE_ENV === 'development' && end_lat === undefined) {
      end_lat = 37.346772;
      end_lng = -122.032235;
      // end_lat = 42.280366;
      // end_lng = -83.744083;
    }
    return request({
      uri: UBER_API_BASE_URL + '/v1/requests',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: product_id,
        start_latitude: start_lat,
        start_longitude: start_lng,
        end_latitude: end_lat,
        end_longitude: end_lng,
      }),
    })
    .then(JSON.parse)
    .then(function(data) {
      return data.request_id;
    })
    .then(function(request_id) {
      return uberDetailsPromise(request, request_id, 2000);
    });
  },

  snapPointsToNearestRoads: function(points) {
    var path = _.map(points, function(pt) {
      return pt.lat.toString() + ',' + pt.lng.toString();
    }).join('|');

    return request({
      uri: 'https://roads.googleapis.com/v1/snapToRoads',
      qs: {
        key: info.GOOGLE_MAPS_API_KEY,
        path: path,
      },
    })
    .then(JSON.parse)
    .then(function(data) {
      return _.map(data.snappedPoints, function(pt) {
        return {
          lat: pt.location.latitude,
          lng: pt.location.longitude,
        };
      });
    });
  },

  walkingDurationFromTo: function(start_lat, start_lng, end_lat, end_lng) {
    return request({
      uri: 'https://maps.googleapis.com/maps/api/directions/json',
      qs: {
        origin: start_lat + ',' + start_lng,
        destination: end_lat + ',' + end_lng,
        key: info.GOOGLE_MAPS_API_KEY,
        mode: 'walking',
        units: 'metric',
      },
    })
    .then(JSON.parse)
    .then(function(data) {
      if (data.routes.length === 0) {
        console.log(data);
        throw 'No route between points.';
      }

      return data.routes[0];
    })
    .then(function(route) {
      var totalDuration = _.reduce(route.legs, function(memo, leg) {
        return memo + leg.duration.value;
      }, 0);

      return [totalDuration, route.legs];
    });
  },

  pollRequestForUser: function(request, user, request_id) {
    return uberInProgressPoll(request, request_id, 5000)
      .then(function() {
        return twilioTextFriendSafe(user);
      });
  },

  degreesToRadians: function(deg) {
    return deg * 0.0174532925;
  },

  twilioCallDriver: function(driver_number, user, eta) {
    console.log(driver_number, user.uuid, eta, info.HOSTNAME + '/twilio?uuid=' + user.uuid + '&eta=' + eta);
    return createCall({
      to: driver_number,
      from: info.TWILIO_NUMBER,
      url: info.HOSTNAME + '/twilio?uuid=' + user.uuid + '&eta=' + eta,
    });
  },

  twilioTextFriend: function(user, eta) {
    var etaMinutes = Math.ceil(eta / 60.0);

    return createMessage({
      to: user.emergencyContacts[0],
      from: info.TWILIO_NUMBER,
      body: 'Hey it\'s ' + user.first_name + ' ' + user.last_name + ', I\'m walking through a place that\'s a little sus, so I called an Uber to pick me up. I\'ll let you known when I\'m ok. I should be there in ' + etaMinutes + ' minutes.',
    });
  },

  twilioTextFriendSafe: twilioTextFriendSafe,

  formatNumber: formatNumber,
};
