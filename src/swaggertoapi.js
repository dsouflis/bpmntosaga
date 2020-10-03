const Handlebars = require("handlebars");
const SwaggerClient = require('swagger-client');

const getClientForSwagger = url => new Promise((resolve, reject) => {
  const clientPromise = new SwaggerClient(url);
  clientPromise
  .then(
      client => resolve(client),
      reason => reject(reason)
  );
});

const clientTmpl = Handlebars.compile(`//{{name}}
import SwaggerClient from 'swagger-client';
const clientPromise = new SwaggerClient({
  url: '{{url}}',
});

const f = (section, method) =>async (...args) => new Promise((resolve, reject) => {
    clientPromise
    .then(
        client => client.apis[section][method](...args),
        reason => reject(reason)
    ).then(
        result => resolve(result),
        reason => reject(reason)
    )
  });

const inst = {
{{#each operations}}
  {{operation}}: f('{{tag}}','{{operation}}'),
{{/each}}  
}

export default inst;
`);

/*
      api= {
        name: 'PetStoreSwagger',
        url: 'https://petstore.swagger.io/v2/swagger.json',
        //todo add auth specs.
      }
*/
const swaggerToApi = async (api) => {
  const client = await getClientForSwagger(api.url);
  const operations = Object.entries(client.apis).flatMap(([tag, v]) => Object.keys(client.apis[tag]).map(operation => ({
    tag, operation
  })));
  let s = clientTmpl({
    name: api.name,
    url: api.url,
    operations
  });
  return s;
}

module.exports = { swaggerToApi };
