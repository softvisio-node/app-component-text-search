import sql from "#core/sql";
import crypto from "node:crypto";
import Mutex from "#core/threads/mutex";
import OpenAiApi from "#core/api/openai";
import { encode as encodeTokens, decode as decodeTokens } from "gpt-tokenizer";

import { readConfig } from "#core/config";
import glob from "#core/glob";

var XENOVA;

const MODELS = {

    // xenova
    "Xenova/all-MiniLM-L6-v2": {
        "provider": "xenova",
        "dimensions": 384,
    },

    // google english
    "text-embedding-004": {
        "provider": "google",
        "dimensions": 768,
    },

    // google multiligual
    "text-multilingual-embedding-002": {
        "provider": "google",
        "dimensions": 768,
    },

    // openai
    "text-embedding-3-small": {
        "provider": "openai",
        "dimensions": 1536,
    },
    "text-embedding-3-large": {
        "provider": "openai",
        "dimensions": 3072,
    },
};

const SQL = {
    "createEmbedding": sql`SELECT text_search_create_embedding( ?, ?, ?, ? ) AS id`.prepare().readOnly( false ),
};

export default class {
    #app;
    #config;
    #mutexes = new Mutex.Set();
    #openAiApi;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;
    }

    // properties
    get app () {
        return this.#app;
    }

    get config () {
        return this.#config;
    }

    get dbh () {
        return this.#app.dbh;
    }

    // public
    // XXX remove
    async init () {

        // init db
        var res = await this.dbh.schema.migrate( new URL( "db", import.meta.url ), {
            "app": this.app,
        } );
        if ( !res.ok ) return res;

        // XXX remove
        await this.#import();

        return result( 200 );
    }

    async createEmbedding ( text, { model, type, dbh } = {} ) {
        model ||= this.config.model;
        type ||= this.config.type;

        const hash = crypto.createHash( "MD5" ).update( text ).digest( "base64url" );

        var res;

        res = await this.#createEmbedding( hash, model, type, { dbh } );

        // error
        if ( !res.ok ) return res;

        // embedding created
        else if ( res.data ) return res;

        const mutex = this.#getMutex( hash );

        await mutex.lock();

        res = await this.#createEmbedding( hash, model, type, { text, dbh } );

        mutex.unlock();

        return res;
    }

    encodeTokens ( text ) {
        return encodeTokens( text );
    }

    decodeTokens ( tokens ) {
        return decodeTokens( tokens );
    }

    // private
    #getMutex ( hash ) {
        const id = "text-search/create-embedding/" + hash;

        if ( this.app.cluster ) {
            return this.app.cluster.mutexes.get( id );
        }
        else {
            return this.#mutexes.get( id );
        }
    }

    async #createEmbedding ( hash, model, type, { text, dbh } = {} ) {
        dbh ||= this.dbh;

        var res;

        res = await dbh.selectRow( SQL.createEmbedding, [ hash, model, type, null ] );

        // error
        if ( !res.ok ) {
            return res;
        }

        // embedding cached
        else if ( res.data?.id ) {
            return res;
        }

        // not created
        else if ( !text ) {
            return result( 200 );
        }

        res = await this.#getEmbedding( text, model, type );
        if ( !res.ok ) return res;

        return dbh.selectRow( SQL.createEmbedding, [ hash, model, type, res.data ] );
    }

    // XXX
    async #getEmbedding ( text, model, type ) {
        if ( MODELS[ model ].provider === "xenova" ) {
            XENOVA ??= await import( "@xenova/transformers" );

            const pipe = await XENOVA.pipeline( "feature-extraction", model );

            const embedding = await pipe( text, { "pooling": "mean", "normalize": true } );

            return result( 200, Array.from( embedding.data ) );
        }
        else if ( MODELS[ model ].provider === "openai" ) {
            if ( !this.config.openAiApiKey ) return result( 500 );

            this.#openAiApi ??= new OpenAiApi( this.config.openAiApiKey );

            const res = await this.#openAiApi.getEmbeddings( text, model );

            if ( !res.ok ) return res;

            return result( 200, res.data.data[ 0 ].embedding );
        }
        else if ( MODELS[ model ].provider === "google" ) {

            // XXX
            return result( 500 );
        }
        else {
            return result( 404 );
        }
    }

    // XXX remove
    async #import () {

        // console.log( JSON.stringify( ( await this.#getEmbedding( "Madison Square Garden in New York City", "Xenova/all-MiniLM-L6-v2" ) ).data ) );
        // process.exit();

        const files = glob( "*.json", {
            "cwd": "/var/local/downloads/wikipedia",
        } );

        var id = 0;

        await this.dbh.exec( sql`
CREATE TABLE IF NOT EXISTS doc (
    id serial4,
    text text,
    embedding_id int53
);
` );

        for ( const file of files ) {
            const data = readConfig( "/var/local/downloads/wikipedia/" + file );

            for ( const doc of data ) {
                let res;

                const hash = crypto.createHash( "MD5" ).update( doc.text ).digest( "base64url" );

                res = await this.dbh.select( sql`SELECT id FROM text_search_embedding_cache WHERE hash = ?`.prepare(), [ hash ] );

                if ( res.data ) {
                    console.log( "--- SKIP" );

                    continue;
                }

                res = await this.createEmbedding( doc.text );

                await this.dbh.do( sql`INSERT INTO doc ( text, embedding_id ) VALUES ( ?, ? )`.prepare(), [ doc.text, res.data.id ] );

                console.log( ++id, res + "" );
            }
        }
    }
}
