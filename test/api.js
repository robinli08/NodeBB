'use strict';

const assert = require('assert');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const request = require('request-promise-native');
const nconf = require('nconf');

const db = require('./mocks/databasemock');
const helpers = require('./helpers');
const user = require('../src/user');
const groups = require('../src/groups');
const categories = require('../src/categories');
const topics = require('../src/topics');
const posts = require('../src/posts');

describe('Read API', async () => {
	let readApi = false;
	const apiPath = path.resolve(__dirname, '../public/openapi/read.yaml');
	let jar;
	let setup = false;
	const unauthenticatedRoutes = ['/api/login', '/api/register'];	// Everything else will be called with the admin user

	async function setupData() {
		if (setup) {
			return;
		}

		// Create admin user
		const adminUid = await user.create({ username: 'admin', password: '123456', email: 'test@example.org' });
		await groups.join('administrators', adminUid);

		// Create a category
		const testCategory = await categories.create({ name: 'test' });

		// Post a new topic
		const testTopic = await topics.post({
			uid: adminUid,
			cid: testCategory.cid,
			title: 'Test Topic',
			content: 'Test topic content',
		});

		jar = await helpers.loginUser('admin', '123456');
		setup = true;
	}

	it('should pass OpenAPI v3 validation', async () => {
		try {
			await SwaggerParser.validate(apiPath);
		} catch (e) {
			assert.ifError(e);
		}
	});

	readApi = await SwaggerParser.dereference(apiPath);

	// Iterate through all documented paths, make a call to it, and compare the result body with what is defined in the spec
	const paths = Object.keys(readApi.paths);

	paths.forEach((path) => {
		let schema;
		let response;
		let url;
		const headers = {};
		const qs = {};

		function compare(schema, response, context) {
			let required = [];

			if (schema.allOf) {
				schema = schema.allOf.reduce((memo, obj) => {
					required = required.concat(obj.required ? obj.required : Object.keys(obj.properties));
					memo = { ...memo, ...obj.properties };
					return memo;
				}, {});
			} else if (schema.properties) {
				required = schema.required || Object.keys(schema.properties);
				schema = schema.properties;
			} else {
				// If schema contains no properties, check passes
				return;
			}

			// TODO: If `required` present, iterate through that, otherwise iterate through all
			required.forEach((prop) => {
				if (schema.hasOwnProperty(prop)) {
					assert(response.hasOwnProperty(prop), '"' + prop + '" is a required property (path: ' + path + ', context: ' + context + ')');

					// Don't proceed with type-check if the value could possibly be unset (nullable: true, in spec)
					if (response[prop] === null && schema[prop].nullable === true) {
						return;
					}

					// Therefore, if the value is actually null, that's a problem (nullable is probably missing)
					assert(response[prop] !== null, '"' + prop + '" was null, but schema does not specify it to be a nullable property (path: ' + path + ', context: ' + context + ')');

					switch (schema[prop].type) {
					case 'string':
						assert.strictEqual(typeof response[prop], 'string', '"' + prop + '" was expected to be a string, but was ' + typeof response[prop] + ' instead (path: ' + path + ', context: ' + context + ')');
						break;
					case 'boolean':
						assert.strictEqual(typeof response[prop], 'boolean', '"' + prop + '" was expected to be a boolean, but was ' + typeof response[prop] + ' instead (path: ' + path + ', context: ' + context + ')');
						break;
					case 'object':
						assert.strictEqual(typeof response[prop], 'object', '"' + prop + '" was expected to be an object, but was ' + typeof response[prop] + ' instead (path: ' + path + ', context: ' + context + ')');
						compare(schema[prop], response[prop], context ? [context, prop].join('.') : prop);
						break;
					case 'array':
						assert.strictEqual(Array.isArray(response[prop]), true, '"' + prop + '" was expected to be an array, but was ' + typeof response[prop] + ' instead (path: ' + path + ', context: ' + context + ')');

						if (schema[prop].items) {
							// Ensure the array items have a schema defined
							assert(schema[prop].items.type || schema[prop].items.allOf, '"' + prop + '" is defined to be an array, but its items have no schema defined (path: ' + path + ', context: ' + context + ')');

							// Compare types
							if (schema[prop].items.type === 'object' || Array.isArray(schema[prop].items.allOf)) {
								response[prop].forEach((res) => {
									compare(schema[prop].items, res, context ? [context, prop].join('.') : prop);
								});
							} else if (response[prop].length) { // for now
								response[prop].forEach((item) => {
									assert.strictEqual(typeof item, schema[prop].items.type, '"' + prop + '" should have ' + schema[prop].items.type + ' items, but found ' + typeof items + ' instead (path: ' + path + ', context: ' + context + ')');
								});
							}
						}
						break;
					}
				}
			});
		}

		// TOXO: fix -- premature exit for POST-only routes
		if (!readApi.paths[path].get) {
			return;
		}

		it('should have examples when parameters are present', () => {
			const parameters = readApi.paths[path].get.parameters;
			let testPath = path;
			if (parameters) {
				parameters.forEach((param) => {
					assert(param.example !== null && param.example !== undefined, path + ' has parameters without examples');

					switch (param.in) {
					case 'path':
						testPath = testPath.replace('{' + param.name + '}', param.example);
						break;
					case 'header':
						headers[param.name] = param.example;
						break;
					case 'query':
						qs[param.name] = param.example;
						break;
					}
				});
			}

			url = nconf.get('url') + testPath;
		});

		it('should resolve with a 200 when called', async () => {
			await setupData();

			try {
				response = await request(url, {
					jar: !unauthenticatedRoutes.includes(path) ? jar : undefined,
					json: true,
					headers: headers,
					qs: qs,
				});
			} catch (e) {
				assert(!e, path + ' resolved with ' + e.message);
			}
		});

		// Recursively iterate through schema properties, comparing type
		it('response should match schema definition', () => {
			const has200 = readApi.paths[path].get.responses['200'];
			if (!has200) {
				return;
			}

			const hasJSON = has200.content['application/json'];
			if (hasJSON) {
				schema = readApi.paths[path].get.responses['200'].content['application/json'].schema;
				compare(schema, response, 'root');
			}

			// TODO someday: text/csv, binary file type checking?
		});
	});
});

describe('Write API', () => {
	let writeApi;
});
