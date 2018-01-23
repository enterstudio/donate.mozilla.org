const stripeKeys = {
  publishableKey: process.env.STRIPE_PUBLIC_KEY,
  // This is just a test key right now, nothing secret about it.
  secretKey: process.env.STRIPE_SECRET_KEY
};

const stripe = require('stripe')(stripeKeys.secretKey);
stripe.setTimeout(25000);

const stripeRoutes = {
  customer: function(transaction) {
    const { email, metadata, stripeToken: source } = transaction;
    return stripe.customers.create({ email, metadata, source });
  },
  single: function(transaction, callback) {
    const { amount, currency, customer, description, metadata } = transaction;
    return stripe.charges.create({ amount, currency, customer, description, metadata });
  },
  recurring: function(transaction, callback) {
    const { currency: plan, quantity, metadata, trialPeriodDays } = transaction;
    const {  id: customerId } = transaction.customer;

    const subscription = { plan, quantity, metadata };

    if (trialPeriodDays) {
      subscription.trial_period_days = trialPeriodDays;
    }

    return stripe.customers.createSubscription(customerId, subscription);
  },
  closeDispute: function(disputeId) {
    return stripe.disputes.close(disputeId);
  },
  updateCharge: function(chargeId, updateData, callback) {
    stripe.charges.update(chargeId, updateData, callback);
  },
  retrieveDispute: function(disputeId) {
    return stripe.disputes.retrieve(disputeId, {
      expand: ["charge"]
    });
  },
  retrieveCharge: function(chargeId, callback) {
    stripe.charges.retrieve(chargeId, {
      expand: ["invoice"]
    }, callback);
  },
  retrieveSubscription: function(customerId, subscriptionId, options, callback) {
    stripe.customers.retrieveSubscription(customerId, subscriptionId, options, callback);
  },
  retrieveCustomer: function(customerId, callback) {
    return stripe.customers.retrieve(customerId);
  },
  constructEvent: function(payload, signature, endpointSecret) {
    var event;

    try {
      event = stripe.webhooks.constructEvent(payload, signature, endpointSecret);
    } catch (constructEventErr) {
      console.error('constructEvent error: ', constructEventErr);
    }

    return event;
  }
};

module.exports = stripeRoutes;
