const Handlebars = require("handlebars");
const SwaggerClient = require('swagger-client');
const dot = require('dot-object');

const getClientForSwagger = spec => new Promise((resolve, reject) => {
  const clientPromise = new SwaggerClient({spec});
  clientPromise
  .then(
      client => resolve(client),
      reason => reject(reason)
  );
});

const clientTmpl = Handlebars.compile(`//{{name}} {{url}}
import SwaggerClient from 'swagger-client';
import dot from 'dot-object';
import merge from 'deepmerge';
import zip from 'lodash/zip';
import jp from "jsonpath";

const spec = {{{spec}}};

const authorizationsStatic = {{{authorizationsStatic}}};
const authorizations = {};

const authorizationsRecipe = (state) => ({
{{#each authorizationsDynamic}}
  "{{key}}": {{{value}}},
{{/each}}
});

const authorizationsSelector = state => {
  let authorizationsDyn = authorizationsRecipe(state);
  dot.object(authorizationsDyn);
  console.log(authorizationsDyn);
  return authorizationsDyn;
};

const updateAuthorizations = store => () => {
  authorizations.authorizations = merge(
    authorizationsStatic,
    authorizationsSelector(store.getState())
  );
};

const clientPromise = (auth) => new SwaggerClient({
  spec,
  authorizations: auth || authorizations.authorizations
});

const findOperationById = (spec, operationId) => {
  const path = \`$..*[?(@.operationId == "\${operationId}")]\`;
  const results = jp.query(spec, path);
  if (results.length) {
    return results[0];
  }
  return null;
};

{{#if positional}}
const combineWithNames = (operationId, args) => {
  const oper = findOperationById(spec, operationId);
  const paramNames = oper.parameters.map(x => x.name);
  const zipped = Object.fromEntries(zip(paramNames, args));
  return [zipped];
}
{{else}}
const combineWithNames = (_, args) => args;
{{/if}}

const fa = (section, method) => async (auth, ...args) => new Promise((resolve, reject) => {
    clientPromise(auth)
    .then(
        client => client.apis[section][method](...combineWithNames(method, args)),
        reason => reject(reason)
    ).then(
        result => resolve(result),
        reason => reject(reason)
    )
  });

const f = (section, method) => async (...args) => new Promise((resolve, reject) => {
    clientPromise()
    .then(
        client => client.apis[section][method](...combineWithNames(method, args)),
        reason => reject(reason)
    ).then(
        result => resolve(result),
        reason => reject(reason)
    )
  });

const inst = {
  _subscribeToReduxStore: (store) => {
    store.subscribe(updateAuthorizations(store));
    updateAuthorizations();
  },
{{#each operations}}
  {{operation}}: f('{{tag}}','{{operation}}'),
  auth_{{operation}}: fa('{{tag}}','{{operation}}'),
{{/each}}  
}

export default inst;
`);

/*
      api= {
        name: 'PetStoreSwagger',
        url: 'https://petstore.swagger.io/v2/swagger.json',
        authorizationsStatic: {},
        authorizationsDynamic: {
          api_key: 'authentication.access_token'
        },
      }
*/

const recipeTempl = Handlebars.compile(`{
{{#each entries}}
{{indent}}    "{{key}}": {{{value}}},
{{/each}}
{{indent}}  }`);

const valueToRecipe = (value, indent = "") => {
  if(typeof value === "object") {
    const iter = Object.entries(value).map(entry => ({ key: entry[0], value: valueToRecipe(entry[1], indent + "  ")}));
    return recipeTempl({
      entries: iter,
      indent
    });
  }
  return `dot.pick('${value}', state)`;
};

const swaggerToApi = async (api) => {
  const client = await getClientForSwagger(api.spec);
  const operations = Object.entries(client.apis).flatMap(([tag, v]) => Object.keys(client.apis[tag]).map(operation => ({
    tag, operation
  })));
  const recipe = Object.entries(api.authorizationsDynamic).map(entry => ({ key: entry[0], value: valueToRecipe(entry[1])}));
  let s = clientTmpl({
    name: api.name,
    url: api.url,
    spec: JSON.stringify(client.spec, null, 2),
    authorizationsStatic: JSON.stringify(api.authorizationsStatic, null, 2),
    authorizationsDynamic: recipe,
    operations
  });
  return s;
}

module.exports = { swaggerToApi };
