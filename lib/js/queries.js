
const app_config = require('../../config.app.js');

addJuneau = function() {
  tab = yasgui.addTab(
    true, // set as active tab
    { requestConfig: {"endpoint": 'https:\/\/'+app_config.data_host+'/sparql'}, name: "Juneau, Alaska" }
  );
  tab.setQuery(`PREFIX gnis: <http:\/\/`+app_config.data_host+`\/lod\/gnis\/ontology\/>
PREFIX gnisf-alias: <http:\/\/`+app_config.data_host+`\/lod/gnis\/feature-alias\/>
PREFIX rdfs: <http:\/\/www.w3.org\/2000\/01\/rdf-schema#>
PREFIX rdf: <http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#>
SELECT ?label ?nodeType ?description where {
  ?s gnis:county gnisf-alias:Alaska.Juneau .
  ?s rdfs:label ?label .
  ?s rdf:type ?nodeType .
  ?s gnis:description ?description .
}
`);
};