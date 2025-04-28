package config

import (
	"github.com/dgraph-io/badger/v4"
	"log"
	"strconv"
	"sync"
)

type Config struct {
	db *badger.DB
}

var once sync.Once
var instance *Config

func GetConfig() *Config {
	once.Do(func() {
		instance = newConfig()
	})
	return instance
}

func newConfig() *Config {
	db, err := badger.Open(badger.DefaultOptions("/tmp/badger"))
	if err != nil {
		log.Fatal(err)
	}
	return &Config{db: db}
}

func (c *Config) Set(key Key, value string) error {
	err := c.db.Update(func(txn *badger.Txn) error {
		err := txn.Set([]byte(key), []byte(value))
		return err
	})
	return err
}

func (c *Config) GetInt(key Key) (int, error) {
	value, err := c.Get(key)
	if err != nil {
		return 0, err
	}
	num, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	return num, nil
}

func (c *Config) Get(key Key) (string, error) {
	var value string
	err := c.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get([]byte(key))
		if err != nil {
			return err
		}
		val, err := item.ValueCopy(nil)
		if err != nil {
			return err
		}
		value = string(val)
		return nil
	})
	return value, err
}

func (c *Config) GetOrDefault(key Key, defaultValue string) string {
	value, err := c.Get(key)
	if err != nil {
		return defaultValue
	}
	return value
}

func (c *Config) GetIntOrDefault(key Key, defaultValue int) int {
	value, err := c.GetInt(key)
	if err != nil {
		return defaultValue
	}
	return value
}
