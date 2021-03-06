package datasource

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/alexanderzobnin/grafana-zabbix/pkg/cache"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// DatasourceCache is a cache for datasource instance.
type DatasourceCache struct {
	cache *cache.Cache
}

// NewDatasourceCache creates a DatasourceCache with expiration(ttl) time and cleanupInterval.
func NewDatasourceCache(ttl time.Duration, cleanupInterval time.Duration) *DatasourceCache {
	return &DatasourceCache{
		cache.NewCache(ttl, cleanupInterval),
	}
}

// GetAPIRequest gets request response from cache
func (c *DatasourceCache) GetAPIRequest(request *ZabbixAPIRequest) (interface{}, bool) {
	requestHash := HashString(request.String())
	return c.cache.Get(requestHash)
}

// SetAPIRequest writes request response to cache
func (c *DatasourceCache) SetAPIRequest(request *ZabbixAPIRequest, response interface{}) {
	requestHash := HashString(request.String())
	c.cache.Set(requestHash, response)
}

// HashString converts the given text string to hash string
func HashString(text string) string {
	hash := sha1.New()
	hash.Write([]byte(text))
	return hex.EncodeToString(hash.Sum(nil))
}

// HashDatasourceInfo converts the given datasource info to hash string
func HashDatasourceInfo(dsInfo *backend.DataSourceInstanceSettings) string {
	digester := sha1.New()
	if err := json.NewEncoder(digester).Encode(dsInfo); err != nil {
		panic(err) // This shouldn't be possible but just in case DatasourceInfo changes
	}
	return hex.EncodeToString(digester.Sum(nil))
}
