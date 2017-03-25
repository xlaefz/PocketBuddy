'use strict';

var mongoose = require('mongoose');
var findOrCreate = require('mongoose-findorcreate');

var UserSchema = new mongoose.Schema({
  accessToken: String,
  picture: String,
  first_name: String,
  last_name: String,
  promo_code: String,
  email: String,
  uuid: String,
  emergencyContacts: [String],
});

UserSchema.plugin(findOrCreate);

module.exports = mongoose.model('User', UserSchema);
