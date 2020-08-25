const _ = require('lodash');
const JSONPath = require('jsonpath-plus').JSONPath;

const aws = require('aws-sdk'); // Loads the AWS SDK for JavaScript.
const config = new aws.ConfigService(); // Constructs a service object to use the aws.ConfigService class.

const COMPLIANCE_STATES = {
    COMPLIANT: 'COMPLIANT',
    NON_COMPLIANT: 'NON_COMPLIANT',
    NOT_APPLICABLE: 'NOT_APPLICABLE',
};

/*
 * a -> value returned from expression evaluation
 * b -> value expected as set via Config parameters
 * Note: you likely want to conver a to a String, since Config parameters will always be Strings
 */
const OPERATORS = {
    EQUALS: (a, b) => _.toString(a) === b,
    NOT_EQUALS: (a, b) => _.toString(a) !== b,
    INCLUDES: (a, b) => a.some(e => _.toString(e) === b),
    NOT_INCLUDES: (a, b) => a.some(e => _.toString(e) === b),
    IS_EMPTY: (a, b) => _(a).isEmpty().toString() === b,
    DOES_EXIST: (a, b) => _(a).isNil().toString() === b
};

var BASE_PROPERTIES = {
    SERVICE: "ApiService",
    ACTION: "ApiAction",
    PARAMS: "ApiParams"
}

var MAIN_STEP = {
    ...BASE_PROPERTIES,
    RESOURCE_SELECTOR: "ResourceSelector",
    RESOURCE_ID: "ResourceIdPath",
    RESOURCE_VALUE: "ResourceValuePath",
    RESULT_QUERY: "ResultQuery",
    COMPARISON_OPERATOR: "ComparisonOperator",
    COMPARISON_VALUE: "ComparisonValue",
    RESOURCE_TYPE: "ResourceType"
}

var SUB_STEP = {
    ...BASE_PROPERTIES,
    OUTPUT: "OutputPath"
}


function getDataRecursive(service, action, params, token = null, data = {}) {
    if (token) params = { ...params, NextToken: token }
    return callApi(service, action, params).then(newData => {
        var nextToken = newData["NextToken"];
        data = _.mergeWith(data, newData, (a, b) => ( _.isArray(a) ? _.concat(a,b) : undefined ));
        if (_.isNil(nextToken)) {
            delete data["NextToken"];
            return data
        };
        console.log("Depaginating results")
        console.log(nextToken)
        return getDataRecursive(service, action, params, nextToken, data);
    });
}

function callApi(service, action, params) {
    console.log(`Calling API ${service}.${action}(${JSON.stringify(params)})`);
    var svc = new aws[service]();
    return svc[action](params).promise()
}

function queryValue(json, path) {
    return _.flatten(JSONPath(path, json));
}

// https://stackoverflow.com/questions/8403108/calling-eval-in-particular-context
function parseParams(string, stack) {
    return function() { return eval(`(${string})`); }.call({ stack: stack });
}

function evaluateStep(stepParams, index, stack) {
    var service = stepParams[SUB_STEP.SERVICE];
    var action = stepParams[SUB_STEP.ACTION];
    var params = parseParams(stepParams[SUB_STEP.PARAMS], stack);
    var outputPath = stepParams[SUB_STEP.OUTPUT];

    return getDataRecursive(service, action, params)
        .then(data => {
            var values = queryValue(data, outputPath);
            console.log('Returned api call results:')
            console.log(values)
            stack[index] = values;
            return stack;
        });
}

function extractParams(params, index) {
    console.log(`Parsing params for index ${index}:`)
    var result = {};
    for (var prop in SUB_STEP) {
        var propName = SUB_STEP[prop];
        var value = params[`${MAIN_STEP.RESOURCE_VALUE}.${index}.${propName}`];
        console.log(`${propName} = ${value}`)
        if (!value) {
            if (!_.isEmpty(result)) throw new Error(`Property ${index}.${propName} expected`);
            break;
        }
        result[propName] = value;
    }
    return result;
}

function recurseEvaluateStep(params, index, stack=[]) {
    console.log('recurseEvaluateStep')
    var stepParams = extractParams(params, index);

    console.log('stepParams:')
    console.log(stepParams)
    console.log('stack:')
    console.log(stack)
    if (_.isEmpty(stepParams)) {
        console.log('recurseEvaluateStep - returning')
        return Promise.resolve(_.last(stack));
    } else {
        console.log('recurseEvaluateStep - recursing')
        return evaluateStep(stepParams, index, stack).then(_ => recurseEvaluateStep(stepParams, index+1, _));
    }
}


// Checks whether the invoking event is ScheduledNotification
function isScheduledNotification(invokingEvent) {
    return (invokingEvent.messageType === 'ScheduledNotification');
}


// code with little or no change.
exports.handler = (event, context, callback) => {
    // Parses the invokingEvent and ruleParameters values, which contain JSON objects passed as strings.
    const invokingEvent = JSON.parse(event.invokingEvent);
    console.log("invokingEvent" )
    console.log(invokingEvent)
    const ruleParameters = JSON.parse(event.ruleParameters);
    console.log("ruleParameters")
    console.log(ruleParameters)
    
    if (isScheduledNotification(invokingEvent)) {

        var stepParams = ruleParameters;
        var service = stepParams[BASE_PROPERTIES.SERVICE];
        var action = stepParams[BASE_PROPERTIES.ACTION];
        var params = eval(`(${stepParams[BASE_PROPERTIES.PARAMS]})`);
        var resourceSelector = stepParams[MAIN_STEP.RESOURCE_SELECTOR];
        var resourceId = stepParams[MAIN_STEP.RESOURCE_ID];
        var resourceValue = stepParams[MAIN_STEP.RESOURCE_VALUE];
        var comparisonOperator = OPERATORS[stepParams[MAIN_STEP.COMPARISON_OPERATOR]];
        var comparisonValue = stepParams[MAIN_STEP.COMPARISON_VALUE];
        var resourceType = stepParams[MAIN_STEP.RESOURCE_TYPE];

        getDataRecursive(service, action, params).
            then( data => {
                var resources = queryValue(data, resourceSelector);
                console.log("Identified resources:")
                console.log(resources)

                var tuple = resources.map(e => {
                    var id = queryValue(e, resourceId);
                    console.log('Resource Id')
                    console.log(id)
                    if (id.length != 1) throw new Error(`Path for ${MAIN_STEP.RESOURCE_VALUE} should return 1 and only 1 value`);
                    id = id[0];

                    console.log('Resource value')
                    if (resourceValue) {

                        var value = queryValue(e, resourceValue);
                        if (value.length != 1) throw new Error(`Path for ${MAIN_STEP.COMPARISON_VALUE} should return 1 and only 1 value`);
                        value = value[0];
                        console.log(value)

                        return Promise.resolve({ id, value });
                    } else {
                        return recurseEvaluateStep(stepParams, 1, [id])
                            .then(value => ({ id, value }));
                    }
                });

                return Promise.all(tuple);
            }).then(data => {

                return data.map(e => ({ id: e.id, compliant: comparisonOperator(e.value, comparisonValue) }))

            })
            .then(data => {
                const evaluations = data.map( e => ({
                    // Applies the evaluation result to the AWS account published in the event.
                    ComplianceResourceType: resourceType,
                    ComplianceResourceId: e.id,
                    ComplianceType: ( e.compliant ? COMPLIANCE_STATES.COMPLIANT : COMPLIANCE_STATES.NON_COMPLIANT ),
                    OrderingTimestamp: new Date(),
                }));
        
                // Initializes the request that contains the evaluation results.
                const putEvaluationsRequest = {
                    Evaluations: evaluations,
                    ResultToken: event.resultToken,
                };
                console.log("putEvaluationsRequest");
                console.log(putEvaluationsRequest);
                
                // Sends the evaluation results to AWS Config.
                return config.putEvaluations(putEvaluationsRequest).promise();
            })
            .then(data => {
                console.log("putEvaluations");
                console.log(data);
        
                return callback(JSON.stringify(data));
            }).catch(err => {
                return callback(err);
            });


    } else {
        callback('Invoked for a notification other than Scheduled Notification... Ignoring.');
    }
};

